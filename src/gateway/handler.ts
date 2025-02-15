import { Timers } from 'detritus-utils';

import { ShardClient } from '../client';
import { BaseCollection } from '../collections/basecollection';
import { BaseSet } from '../collections/baseset';
import {
  AuthTypes,
  ClientEvents,
  GatewayDispatchEvents,
  GatewayOpCodes,
  MessageCacheTypes,
  PresenceStatuses,
} from '../constants';
import { GatewayHTTPError } from '../errors';

import {
  createChannelFromData,
  Channel,
  ChannelDM,
  Emoji,
  Guild,
  Member,
  Message,
  Presence,
  Reaction,
  Relationship,
  Role,
  Typing,
  User,
  UserMe,
  VoiceCall,
  VoiceState,
} from '../structures';

import { GatewayClientEvents } from './clientevents';
import { GatewayRawEvents } from './rawevents';


export interface GatewayHandlerOptions {
  disabledEvents?: Array<string>,
  loadAllMembers?: boolean,
  whitelistedEvents?: Array<string>,
}


/**
 * Gateway Handler
 * @category Handler
 */
export class GatewayHandler {
  readonly client: ShardClient;
  disabledEvents: BaseSet<string>;
  dispatchHandler: GatewayDispatchHandler;
  loadAllMembers: boolean = false;

  memberChunks = {
    delay: 2000,
    done: new BaseSet<string>(),
    left: new BaseSet<string>(),
    sending: new BaseSet<string>(),
    timer: new Timers.Timeout(),
  };

  constructor(
    client: ShardClient,
    options: GatewayHandlerOptions = {},
  ) {
    this.client = client;
    this.client.gateway.on('killed', this.onKilled.bind(this));
    this.client.gateway.on('packet', this.onPacket.bind(this));

    this.dispatchHandler = new GatewayDispatchHandler(this);
    this.disabledEvents = new BaseSet((options.disabledEvents || []).map((v) => {
      return v.toUpperCase();
    }));
    this.loadAllMembers = !!options.loadAllMembers;

    if (options.whitelistedEvents) {
      this.disabledEvents.clear();
      for (let event of Object.values(GatewayDispatchEvents)) {
        this.disabledEvents.add(event);
      }
      for (let event of options.whitelistedEvents) {
        this.disabledEvents.delete(event.toUpperCase());
      }
    }
    this.disabledEvents.delete(GatewayDispatchEvents.READY);
  }

  get shouldLoadAllMembers(): boolean {
    return this.loadAllMembers && this.client.gateway.guildSubscriptions;
  }

  onKilled(payload: {error?: Error}): void {
    if (!this.client.killed) {
      this.client.kill(payload.error);
    }
  }

  onPacket(packet: GatewayRawEvents.GatewayPacket): void {
    if (packet.op !== GatewayOpCodes.DISPATCH) {
      return;
    }
    const { d: data, t: name} = packet;

    if (this.client.hasEventListener(ClientEvents.RAW)) {
      this.client.emit(ClientEvents.RAW, packet);
    }
    if (!this.disabledEvents.has(name)) {
      const handler = this.dispatchHandler.getHandler(name);
      if (handler) {
        handler.call(this.dispatchHandler, data);
      } else {
        this.client.emit(ClientEvents.UNKNOWN, packet);
      }
    }
  }
}


/**
 * Gateway Dispatch Handler Function
 * @category Handlers
 */
export type GatewayDispatchHandlerFunction = (data: any) => void;


/**
 * Gateway Dispatch Handler
 * @category Handlers
 */
export class GatewayDispatchHandler {
  handler: GatewayHandler;

  constructor(handler: GatewayHandler) {
    this.handler = handler;
  }

  get client() {
    return this.handler.client;
  }

  getHandler(name: string): GatewayDispatchHandlerFunction | undefined {
    return (<any> this)[name];
  }

  /* Dispatch Events */
  async [GatewayDispatchEvents.READY](data: GatewayRawEvents.Ready) {
    this.client.reset();

    let me: UserMe;
    if (this.client.user) {
      me = this.client.user;
      me.merge(data['user']);
    } else {
      me = new UserMe(this.client, data['user']);
      this.client.user = me;
    }
    this.client.users.insert(me); // since we reset the cache

    Object.defineProperty(this.client, '_isBot', {value: data['user']['bot']});
    const authType = (this.client.isBot) ? AuthTypes.BOT : AuthTypes.USER;
    this.client.rest.setAuthType(authType);

    // data['analytics_token']
    if (data['connected_accounts']) {
      // make a cache for this?
    }

    if (this.client.guilds.enabled) {
      const requestChunksNow: Array<string> = [];
      for (let raw of data['guilds']) {
        let guild: Guild;
        if (this.client.guilds.has(raw.id)) {
          guild = <Guild> this.client.guilds.get(raw.id);
          guild.merge(raw);
        } else {
          guild = new Guild(this.client, raw);
          this.client.guilds.insert(guild);
        }
        if (this.handler.shouldLoadAllMembers) {
          if (guild.unavailable) {
            this.handler.memberChunks.left.add(guild.id);
          } else {
            if (guild.members.length !== guild.memberCount) {
              requestChunksNow.push(guild.id);
              this.handler.memberChunks.done.add(guild.id);
            }
          }
        }
      }
      if (requestChunksNow.length) {
        this.client.gateway.requestGuildMembers(requestChunksNow, {
          limit: 0,
          presences: true,
          query: '',
        });
      }
    }

    if (this.client.notes.enabled && data['notes']) {
      for (let userId in data['notes']) {
        this.client.notes.insert(userId, data['notes'][userId]);
      }
    }

    if (this.client.presences.enabled && data['presences']) {
      for (let raw of data['presences']) {
        this.client.presences.insert(raw);
      }
    }

    if (this.client.channels.enabled && data['private_channels']) {
      for (let raw of data['private_channels']) {
        if (this.client.channels.has(raw.id)) {
          (<Channel> this.client.channels.get(raw.id)).merge(raw);
        } else {
          this.client.channels.insert(createChannelFromData(this.client, raw));
        }
      }
    }

    if (this.client.relationships.enabled && data['relationships']) {
      for (let raw of data['relationships']) {
        if (this.client.relationships.has(raw.id)) {
          (<Relationship> this.client.relationships.get(raw.id)).merge(raw);
        } else {
          this.client.relationships.insert(new Relationship(this.client, raw));
        }
      }
    }

    if (this.client.sessions.enabled && data['sessions']) {
      for (let raw of data['sessions']) {

      }
    }

    if (data['user_settings']) {

    }

    if (this.client.isBot) {
      try {
        await this.client.rest.fetchOauth2Application();
      } catch(error) {
        const payload: GatewayClientEvents.Warn = {error: new GatewayHTTPError('Failed to fetch OAuth2 Application Information', error)};
        this.client.emit(ClientEvents.WARN, payload);
      }
    } else {
      this.client.owners.set(me.id, me);
    }

    try {
      await this.client.applications.fill();
    } catch(error) {
      const payload: GatewayClientEvents.Warn = {error: new GatewayHTTPError('Failed to fetch Applications', error)};
      this.client.emit(ClientEvents.WARN, payload);
    }

    const payload: GatewayClientEvents.GatewayReady = {raw: data};
    this.client.emit(ClientEvents.GATEWAY_READY, payload);
  }

  [GatewayDispatchEvents.RESUMED](data: GatewayRawEvents.Resumed) {
    this.client.gateway.discordTrace = data['_trace'];

    const payload: GatewayClientEvents.GatewayResumed = {raw: data};
    this.client.emit(ClientEvents.GATEWAY_RESUMED, payload);
  }

  [GatewayDispatchEvents.ACTIVITY_JOIN_INVITE](data: GatewayRawEvents.ActivityJoinInvite) {

  }

  [GatewayDispatchEvents.ACTIVITY_JOIN_REQUEST](data: GatewayRawEvents.ActivityJoinRequest) {

  }

  [GatewayDispatchEvents.ACTIVITY_START](data: GatewayRawEvents.ActivityStart) {

  }

  [GatewayDispatchEvents.BRAINTREE_POPUP_BRIDGE_CALLBACK](data: GatewayRawEvents.BraintreePopupBridgeCallback) {

  }

  [GatewayDispatchEvents.CALL_CREATE](data: GatewayRawEvents.CallCreate) {
    let call: VoiceCall;
    if (this.client.voiceCalls.has(data['channel_id'])) {
      call = <VoiceCall> this.client.voiceCalls.get(data['channel_id']);
      call.merge(data);
    } else {
      call = new VoiceCall(this.client, data);
      this.client.voiceCalls.insert(call);
    }

    const payload: GatewayClientEvents.CallCreate = {call};
    this.client.emit(ClientEvents.CALL_CREATE, payload);
  }

  [GatewayDispatchEvents.CALL_DELETE](data: GatewayRawEvents.CallDelete) {
    let channelId: string = data['channel_id'];
    if (this.client.voiceCalls.has(channelId)) {
      const call = <VoiceCall> this.client.voiceCalls.get(channelId);
      call.kill();
    }

    const payload: GatewayClientEvents.CallDelete = {channelId};
    this.client.emit(ClientEvents.CALL_DELETE, payload);
  }

  [GatewayDispatchEvents.CALL_UPDATE](data: GatewayRawEvents.CallUpdate) {
    let call: VoiceCall;
    let channelId: string = data['channel_id'];
    let differences: any = null;
    if (this.client.voiceCalls.has(data['channel_id'])) {
      call = <VoiceCall> this.client.voiceCalls.get(data['channel_id']);
      if (this.client.hasEventListener(ClientEvents.CALL_UPDATE)) {
        differences = call.differences(data);
      }
      call.merge(data);
    } else {
      call = new VoiceCall(this.client, data);
      this.client.voiceCalls.insert(call);
    }

    const payload: GatewayClientEvents.CallUpdate = {call, channelId, differences};
    this.client.emit(ClientEvents.CALL_UPDATE, payload);
  }

  [GatewayDispatchEvents.CHANNEL_CREATE](data: GatewayRawEvents.ChannelCreate) {
    let channel: Channel;
    if (this.client.channels.has(data['id'])) {
      channel = <Channel> this.client.channels.get(data['id']);
      channel.merge(data);
    } else {
      channel = createChannelFromData(this.client, data);
      this.client.channels.insert(channel);
    }

    const payload: GatewayClientEvents.ChannelCreate = {channel};
    this.client.emit(ClientEvents.CHANNEL_CREATE, payload);
  }

  [GatewayDispatchEvents.CHANNEL_DELETE](data: GatewayRawEvents.ChannelDelete) {
    let channel: Channel;
    if (this.client.channels.has(data['id'])) {
      channel = <Channel> this.client.channels.get(data['id']);
      this.client.channels.delete(data['id']);
    } else {
      channel = createChannelFromData(this.client, data);
    }

    if (channel.isText) {
      switch (this.client.messages.type) {
        case MessageCacheTypes.CHANNEL: {
          this.client.messages.delete(channel.id);
        }; break;
        case MessageCacheTypes.GUILD: {
          if (channel.isGuildChannel) {
            const cache = this.client.messages.get(channel.guildId);
            if (cache) {
              for (let [messageId, message] of cache) {
                if (message.channelId === channel.id) {
                  cache.delete(messageId);
                }
              }
            }
          } else {
            this.client.messages.delete(channel.id);
          }
        }; break;
        case MessageCacheTypes.USER: {
          for (let [messageId, message] of this.client.messages) {
            if (message.channelId === channel.id) {
              this.client.messages.delete(message.author.id, messageId);
            }
          }
        }; break;
      }
    }

    const payload: GatewayClientEvents.ChannelDelete = {channel};
    this.client.emit(ClientEvents.CHANNEL_DELETE, payload);
  }

  [GatewayDispatchEvents.CHANNEL_PINS_ACK](data: GatewayRawEvents.ChannelPinsAck) {

  }

  [GatewayDispatchEvents.CHANNEL_PINS_UPDATE](data: GatewayRawEvents.ChannelPinsUpdate) {
    let channel: Channel | null = null;
    if (this.client.channels.has(data['channel_id'])) {
      channel = <Channel> this.client.channels.get(data['channel_id']);
      channel.merge({
        last_pin_timestamp: data['last_pin_timestamp'],
      });
    }

    const payload: GatewayClientEvents.ChannelPinsUpdate = {
      channel,
      channelId: data['channel_id'],
      guildId: data['guild_id'],
      lastPinTimestamp: data['last_pin_timestamp'],
    };
    this.client.emit(ClientEvents.CHANNEL_PINS_UPDATE, payload);
  }

  [GatewayDispatchEvents.CHANNEL_UPDATE](data: GatewayRawEvents.ChannelUpdate) {
    let channel: Channel;
    let differences: any = null;
    if (this.client.channels.has(data['id'])) {
      channel = <Channel> this.client.channels.get(data['id']);
      if (this.client.hasEventListener(ClientEvents.CHANNEL_UPDATE)) {
        differences = channel.differences(data);
      }
      channel.merge(data);
    } else {
      channel = createChannelFromData(this.client, data);
      this.client.channels.insert(channel);
    }

    const payload: GatewayClientEvents.ChannelUpdate = {channel, differences};
    this.client.emit(ClientEvents.CHANNEL_UPDATE, payload);
  }

  [GatewayDispatchEvents.CHANNEL_RECIPIENT_ADD](data: GatewayRawEvents.ChannelRecipientAdd) {
    let channel: ChannelDM | null = null;
    const channelId = data['channel_id'];
    const nick = data['nick'] || null;
    let user: User;

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data);
    } else {
      user = new User(this.client, data);
      this.client.users.insert(user);
    }

    if (this.client.channels.has(channelId)) {
      channel = <ChannelDM> this.client.channels.get(channelId);
      channel.recipients.set(user.id, user);
      if (nick) {
        channel.nicks.set(user.id, nick);
      } else {
        channel.nicks.delete(user.id);
      }
    }

    const payload: GatewayClientEvents.ChannelRecipientAdd = {
      channel,
      channelId,
      nick,
      user,
    };
    this.client.emit(ClientEvents.CHANNEL_RECIPIENT_ADD, payload);
  }

  [GatewayDispatchEvents.CHANNEL_RECIPIENT_REMOVE](data: GatewayRawEvents.ChannelRecipientRemove) {
    let channel: ChannelDM | null = null;
    const channelId = data['channel_id'];
    const nick = data['nick'] || null;
    let user: User;

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data);
    } else {
      user = new User(this.client, data);
      this.client.users.insert(user);
    }

    if (this.client.channels.has(channelId)) {
      channel = <ChannelDM> this.client.channels.get(channelId);
      channel.recipients.delete(user.id);
      channel.nicks.delete(user.id);
    }

    const payload: GatewayClientEvents.ChannelRecipientRemove = {
      channel,
      channelId,
      nick,
      user,
    };
    this.client.emit(ClientEvents.CHANNEL_RECIPIENT_REMOVE, payload);
  }

  [GatewayDispatchEvents.ENTITLEMENT_CREATE](data: GatewayRawEvents.EntitlementCreate) {

  }

  [GatewayDispatchEvents.ENTITLEMENT_DELETE](data: GatewayRawEvents.EntitlementDelete) {

  }

  [GatewayDispatchEvents.ENTITLEMENT_UPDATE](data: GatewayRawEvents.EntitlementUpdate) {

  }

  [GatewayDispatchEvents.FRIEND_SUGGESTION_CREATE](data: GatewayRawEvents.FriendSuggestionCreate) {
    this.client.emit(ClientEvents.FRIEND_SUGGESTION_CREATE, {
      reasons: data.reasons.map((reason: any) => {
        return {name: reason['name'], platformType: reason['platform_type']};
      }),
      user: new User(this.client, data['suggested_user']),
    });
  }

  [GatewayDispatchEvents.FRIEND_SUGGESTION_DELETE](data: GatewayRawEvents.FriendSuggestionDelete) {
    this.client.emit(ClientEvents.FRIEND_SUGGESTION_DELETE, {
      suggestedUserId: data['suggested_user_id'],
    });
  }

  [GatewayDispatchEvents.GIFT_CODE_UPDATE](data: GatewayRawEvents.GiftCodeUpdate) {
    this.client.emit(ClientEvents.GIFT_CODE_UPDATE, {
      code: data['code'],
      uses: data['uses'],
    });
  }

  [GatewayDispatchEvents.GUILD_BAN_ADD](data: GatewayRawEvents.GuildBanAdd) {
    const guild = this.client.guilds.get(data['guild_id']);
    const guildId = data['guild_id'];
    let user: User;

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data['user']);
    } else {
      user = new User(this.client, data['user']);
    }

    this.client.emit(ClientEvents.GUILD_BAN_ADD, {
      guild,
      guildId,
      user,
    });
  }

  [GatewayDispatchEvents.GUILD_BAN_REMOVE](data: GatewayRawEvents.GuildBanRemove) {
    const guild = this.client.guilds.get(data['guild_id']);
    const guildId = data['guild_id'];
    let user: User;

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data['user']);
    } else {
      user = new User(this.client, data['user'])
    }

    this.client.emit(ClientEvents.GUILD_BAN_REMOVE, {
      guild,
      guildId,
      user,
    });
  }

  [GatewayDispatchEvents.GUILD_CREATE](data: GatewayRawEvents.GuildCreate) {
    let fromUnavailable = false;
    let guild: Guild;

    if (this.client.guilds.has(data['id'])) {
      guild = <Guild> this.client.guilds.get(data['id']);
      fromUnavailable = guild.unavailable;
      guild.merge(data);
    } else {
      guild = new Guild(this.client, data);
      this.client.guilds.insert(guild);
    }

    if (this.handler.shouldLoadAllMembers) {
      if (!this.handler.memberChunks.done.has(guild.id)) {
        this.handler.memberChunks.left.add(guild.id);
      }

      if (this.handler.memberChunks.left.has(guild.id)) {
        if (guild.members.length !== guild.memberCount) {
          this.handler.memberChunks.sending.add(guild.id);
          this.handler.memberChunks.timer.start(this.handler.memberChunks.delay, () => {
            const guildIds = this.handler.memberChunks.sending.toArray();
            this.handler.memberChunks.sending.clear();
            if (guildIds.length) {
              this.client.gateway.requestGuildMembers(guildIds, {
                limit: 0,
                presences: true,
                query: '',
              });
            }
          });
        }
        this.handler.memberChunks.done.add(guild.id);
        this.handler.memberChunks.left.delete(guild.id);
      }
    }

    this.client.emit(ClientEvents.GUILD_CREATE, {
      fromUnavailable,
      guild,
    });
  }

  [GatewayDispatchEvents.GUILD_DELETE](data: GatewayRawEvents.GuildDelete) {
    let guild: Guild | null = null;
    const guildId = data['id'];
    const isUnavailable = !!data['unavailable'];

    this.handler.memberChunks.done.delete(guildId);
    this.handler.memberChunks.sending.delete(guildId);

    let isNew: boolean;
    if (this.client.guilds.has(data['id'])) {
      guild = <Guild> this.client.guilds.get(data['id']);
      guild.merge(data);
      isNew = false;
    } else {
      guild = new Guild(this.client, data);
      this.client.guilds.insert(guild);
      isNew = true;
    }

    if (!isNew || !this.client.guilds.enabled) {
      for (let [channelId, channel] of this.client.channels) {
        if (channel.guildId === guildId) {
          channel.permissionOverwrites.clear();
          this.client.channels.delete(channelId);
          this.client.messages.delete(channelId);

          const typings = this.client.typings.get(channelId);
          if (typings) {
            for (let [userId, typing] of typings) {
              typing.timeout.stop();
              typings.delete(userId);
            }
            typings.clear();
          }
        }
      }

      this.client.members.delete(guildId); // check each member and see if we should clear the user obj from cache too
      this.client.messages.delete(guildId);
      this.client.presences.clearGuildId(guildId);
      this.client.voiceStates.delete(guildId);

      if (this.client.messages.type === MessageCacheTypes.USER) {
        for (let [messageId, message] of this.client.messages) {
          if (message.guildId === guildId) {
            this.client.messages.delete(message.author.id, messageId);
          }
        }
      }
    }

    if (!isUnavailable) {
      this.client.guilds.delete(guildId);
    }

    const payload: GatewayClientEvents.GuildDelete = {guild, guildId, isUnavailable};
    this.client.emit(ClientEvents.GUILD_DELETE, payload);
  }

  [GatewayDispatchEvents.GUILD_EMOJIS_UPDATE](data: GatewayRawEvents.GuildEmojisUpdate) {
    let emojis: BaseCollection<string, Emoji>;
    let emojisOld: BaseCollection<string, Emoji> | null = null;
    let guild: Guild | null = null;
    const guildId = data['guild_id'];

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (this.client.hasEventListener(ClientEvents.GUILD_EMOJIS_UPDATE)) {
        emojisOld = guild.emojis.clone();
      }
      guild.merge({emojis: data['emojis']});
      emojis = guild.emojis;
    } else {
      emojisOld = new BaseCollection();

      emojis = new BaseCollection();
      for (let raw of data['emojis']) {
        const emojiId = <string> raw.id;

        let emoji: Emoji;
        if (this.client.emojis.has(guildId, emojiId)) {
          emoji = <Emoji> this.client.emojis.get(guildId, emojiId);
          emoji.merge(raw);
        } else {
          Object.assign(raw, {guild_id: guildId});
          emoji = new Emoji(this.client, raw);
        }
        emojis.set(emojiId, emoji);
      }
    }

    const payload: GatewayClientEvents.GuildEmojisUpdate = {emojis, emojisOld, guild, guildId};
    this.client.emit(ClientEvents.GUILD_EMOJIS_UPDATE, payload);
  }

  [GatewayDispatchEvents.GUILD_INTEGRATIONS_UPDATE](data: GatewayRawEvents.GuildIntegrationsUpdate) {
    this.client.emit(ClientEvents.GUILD_INTEGRATIONS_UPDATE, {
      guildId: data['guild_id'],
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBER_ADD](data: GatewayRawEvents.GuildMemberAdd) {
    const guildId = data['guild_id'];
    let member: Member;

    if (this.client.members.has(guildId, data['user']['id'])) {
      member = <Member> this.client.members.get(guildId, data['user']['id']);
      member.merge(data);
    } else {
      member = new Member(this.client, data);
      this.client.members.insert(member);
    }

    if (this.client.guilds.has(guildId)) {
      const guild = <Guild> this.client.guilds.get(guildId);
      guild.memberCount++;
    }

    const payload: GatewayClientEvents.GuildMemberAdd = {guildId, member};
    this.client.emit(ClientEvents.GUILD_MEMBER_ADD, payload);
  }

  [GatewayDispatchEvents.GUILD_MEMBER_LIST_UPDATE](data: GatewayRawEvents.GuildMemberListUpdate) {
    this.client.emit(ClientEvents.GUILD_MEMBER_LIST_UPDATE, {
      raw: data,
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBER_REMOVE](data: GatewayRawEvents.GuildMemberRemove) {
    const guildId = data['guild_id'];
    let user: User;

    if (this.client.users.has(data['user']['id'])) {
      user = <User> this.client.users.get(data['user']['id']);
      user.merge(data['user']);
    } else {
      user = new User(this.client, data['user']);
    }

    if (this.client.guilds.has(guildId)) {
      const guild = <Guild> this.client.guilds.get(guildId);
      guild.memberCount--;
    }

    if (this.client.presences.has(user.id)) {
      const presence = <Presence> this.client.presences.get(user.id);
      presence._deleteGuildId(guildId);
      if (!presence.guildIds.length) {
        this.client.presences.delete(user.id);
      }
    }

    for (let [cacheId, cache] of this.client.typings.caches) {
      if (cache.has(user.id)) {
        const typing = <Typing> cache.get(user.id);
        typing._stop(false);
      }
    }

    this.client.members.delete(guildId, user.id);
    this.client.voiceStates.delete(guildId, user.id);

    // do a guild sweep for mutual guilds
    const sharesGuilds = this.client.guilds.some((guild) => guild.members.has(user.id));
    if (!sharesGuilds) {
      // do a channel sweep for mutual dms
      const sharesDms = this.client.channels.some((channel) => channel.recipients.has(user.id));
      if (!sharesDms) {
        // relationship check
        if (!this.client.relationships.has(user.id)) {
          this.client.users.delete(user.id);
        }
      }
    }

    const payload: GatewayClientEvents.GuildMemberRemove = {guildId, user};
    this.client.emit(ClientEvents.GUILD_MEMBER_REMOVE, payload);
  }

  [GatewayDispatchEvents.GUILD_MEMBER_UPDATE](data: GatewayRawEvents.GuildMemberUpdate) {
    let differences: any = null;
    const guildId = data['guild_id'];
    let member: Member;

    const isListening = this.client.hasEventListener(ClientEvents.GUILD_MEMBER_UPDATE);
    if (this.client.members.has(guildId, data['user']['id'])) {
      member = <Member> this.client.members.get(guildId, data['user']['id']);
      if (isListening) {
        differences = member.differences(data);
      }
      if (!!member.premiumSinceUnix !== !!data['premium_since']) {
        if (this.client.guilds.has(guildId)) {
          const guild = <Guild> this.client.guilds.get(guildId);
          if (data['premium_since']) {
            // they just boosted since `member.premiumSince` is null
            guild.premiumSubscriptionCount++;
          } else {
            // they just unboosted since `data['premium_since'] is null
            guild.premiumSubscriptionCount--;
          }
        }
      }
      member.merge(data);
    } else {
      member = new Member(this.client, data);
      this.client.members.insert(member);
    }

    this.client.emit(ClientEvents.GUILD_MEMBER_UPDATE, {
      differences,
      guildId,
      member,
    });
  }

  [GatewayDispatchEvents.GUILD_MEMBERS_CHUNK](data: GatewayRawEvents.GuildMembersChunk) {
    const guildId = data['guild_id'];
    let guild: Guild | null = this.client.guilds.get(guildId) || null;
    let members: BaseCollection<string, Member> | null = null;
    let notFound: Array<string> | null = null;
    let presences: BaseCollection<string, Presence> | null = null;

    const isListening = this.client.hasEventListener(ClientEvents.GUILD_MEMBERS_CHUNK);

    // do presences first since the members cache might depend on it (storeOffline = false)
    if (data['presences']) {
      presences = new BaseCollection<string, Presence>();
      if (this.client.presences.enabled || isListening) {
        for (let value of data['presences']) {
          value.guild_id = guildId;
          const presence = this.client.presences.insert(value);
          if (isListening) {
            presences.set(presence.user.id, presence);
          }
        }
      }
    }

    if (data['members']) {
      // we (the bot user) won't be in the chunk anyways, right?
      if (this.client.members.enabled || isListening) {
        members = new BaseCollection<string, Member>();
        for (let value of data['members']) {
          let rawUser = <GatewayRawEvents.RawUser> value.user;
          let member: Member;
          if (this.client.members.has(guildId, rawUser.id)) {
            member = <Member> this.client.members.get(guildId, rawUser.id);
            member.merge(value);
          } else {
            member = new Member(this.client, Object.assign(value, {guild_id: guildId}));
            this.client.members.insert(member);
          }

          if (isListening) {
            members.set(member.id, member);
          }
        }
      } else if (this.client.presences.enabled || this.client.users.enabled) {
        for (let value of data['members']) {
          let raw = <GatewayRawEvents.RawUser> value.user;
          let user: User;
          if (this.client.users.has(raw.id)) {
            user = <User> this.client.users.get(raw.id);
            user.merge(raw);
          } else {
            user = new User(this.client, raw);
            this.client.users.insert(user);
          }
        }
      }
    }

    if (data['not_found']) {
      // user ids
      // if the userId is not a big int, it'll be an integer..
      notFound = data['not_found'].map((userId) => String(userId));
    }

    const payload: GatewayClientEvents.GuildMembersChunk = {
      guild,
      guildId,
      members,
      notFound,
      presences,
    };
    this.client.emit(ClientEvents.GUILD_MEMBERS_CHUNK, payload);
  }

  [GatewayDispatchEvents.GUILD_ROLE_CREATE](data: GatewayRawEvents.GuildRoleCreate) {
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let role: Role;

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (guild.roles.has(data['role']['id'])) {
        role = <Role> guild.roles.get(data['role']['id']);
        role.merge(data['role']);
      } else {
        data['role']['guild_id'] = guildId;
        role = new Role(this.client, data['role']);
        guild.roles.set(role.id, role);
      }
    } else {
      data['role']['guild_id'] = guildId;
      role = new Role(this.client, data['role']);
    }

    // Bots join with the managed role id already inside it, but we get the role afterwards
    const members = this.client.members.get(guildId);
    if (members) {
      for (let [userId, member] of members) {
        if (member.roles.has(role.id)) {
          member.roles.set(role.id, role);
        }
      }
    }

    this.client.emit(ClientEvents.GUILD_ROLE_CREATE, {
      guild,
      guildId,
      role,
    });
  }

  [GatewayDispatchEvents.GUILD_ROLE_DELETE](data: GatewayRawEvents.GuildRoleDelete) {
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let role: null | Role = null;
    const roleId = data['role_id'];

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (guild.roles.has(roleId)) {
        role = <Role> guild.roles.get(roleId);
        guild.roles.delete(roleId);
      }
    }

    const members = this.client.members.get(guildId);
    if (members) {
      for (let [userId, member] of members) {
        member.roles.delete(roleId);
      }
    }

    this.client.emit(ClientEvents.GUILD_ROLE_DELETE, {
      guild,
      guildId,
      role,
      roleId,
    });
  }

  [GatewayDispatchEvents.GUILD_ROLE_UPDATE](data: GatewayRawEvents.GuildRoleUpdate) {
    let differences: any = null;
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let role: Role;

    if (this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
      if (guild.roles.has(data['role']['id'])) {
        role = <Role> guild.roles.get(data['role']['id']);
        if (this.client.hasEventListener(ClientEvents.GUILD_ROLE_UPDATE)) {
          differences = role.differences(data['role']);
        }
        role.merge(data['role']);
      } else {
        data['role']['guild_id'] = guildId;
        role = new Role(this.client, data['role']);
        guild.roles.set(role.id, role);
      }
    } else {
      data['role']['guild_id'] = guildId;
      role = new Role(this.client, data['role']);
    }

    this.client.emit(ClientEvents.GUILD_ROLE_UPDATE, {
      differences,
      guild,
      guildId,
      role,
    });
  }

  [GatewayDispatchEvents.GUILD_UPDATE](data: GatewayRawEvents.GuildUpdate) {
    let differences: any = null;
    let guild: Guild;

    if (this.client.guilds.has(data['id'])) {
      guild = <Guild> this.client.guilds.get(data['id']);
      if (this.client.hasEventListener(ClientEvents.GUILD_UPDATE)) {
        differences = guild.differences(data);
      }
      guild.merge(data);
    } else {
      guild = new Guild(this.client, data);
      this.client.guilds.insert(guild);
    }
    guild.hasMetadata = true;

    this.client.emit(ClientEvents.GUILD_UPDATE, {
      differences,
      guild,
    });
  }

  [GatewayDispatchEvents.LIBRARY_APPLICATION_UPDATE](data: GatewayRawEvents.LibraryApplicationUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_CREATE](data: GatewayRawEvents.LobbyCreate) {

  }

  [GatewayDispatchEvents.LOBBY_DELETE](data: GatewayRawEvents.LobbyDelete) {

  }

  [GatewayDispatchEvents.LOBBY_UPDATE](data: GatewayRawEvents.LobbyUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_MEMBER_CONNECT](data: GatewayRawEvents.LobbyMemberConnect) {

  }

  [GatewayDispatchEvents.LOBBY_MEMBER_DISCONNECT](data: GatewayRawEvents.LobbyMemberDisconnect) {

  }

  [GatewayDispatchEvents.LOBBY_MEMBER_UPDATE](data: GatewayRawEvents.LobbyMemberUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_MESSAGE](data: GatewayRawEvents.LobbyMessage) {

  }

  [GatewayDispatchEvents.LOBBY_VOICE_SERVER_UPDATE](data: GatewayRawEvents.LobbyVoiceServerUpdate) {

  }

  [GatewayDispatchEvents.LOBBY_VOICE_STATE_UPDATE](data: GatewayRawEvents.LobbyVoiceStateUpdate) {

  }

  [GatewayDispatchEvents.MESSAGE_ACK](data: GatewayRawEvents.MessageAck) {

  }

  [GatewayDispatchEvents.MESSAGE_CREATE](data: GatewayRawEvents.MessageCreate) {
    let message: Message;
    let typing: null | Typing = null;

    let cacheKey: null | string = null;
    switch (this.client.messages.type) {
      case MessageCacheTypes.CHANNEL: {
        cacheKey = data['channel_id'];
      }; break;
      case MessageCacheTypes.GUILD: {
        cacheKey = data['guild_id'] || data['channel_id'];
      }; break;
      case MessageCacheTypes.USER: {
        cacheKey = null;
      }; break;
    }

    if (this.client.messages.has(cacheKey, data['id'])) {
      message = <Message> this.client.messages.get(cacheKey, data['id']);
      message.merge(data);
    } else {
      message = new Message(this.client, data);
      this.client.messages.insert(message);
    }

    if (this.client.channels.has(message.channelId)) {
      const channel = <Channel> this.client.channels.get(message.channelId);
      channel.merge({last_message_id: message.id});
    }

    const cache = this.client.typings.get(message.channelId);
    if (cache) {
      if (cache.has(message.author.id)) {
        typing = <Typing> cache.get(message.author.id);
        typing._stop();
      }
    }

    const payload: GatewayClientEvents.MessageCreate = {message, typing};
    this.client.emit(ClientEvents.MESSAGE_CREATE, payload);
  }

  [GatewayDispatchEvents.MESSAGE_DELETE](data: GatewayRawEvents.MessageDelete) {
    let message: Message | null = null;

    let cacheKey: null | string = null;
    switch (this.client.messages.type) {
      case MessageCacheTypes.CHANNEL: {
        cacheKey = data['channel_id'];
      }; break;
      case MessageCacheTypes.GUILD: {
        cacheKey = data['guild_id'] || data['channel_id'];
      }; break;
      case MessageCacheTypes.USER: {
        cacheKey = null;
      }; break;
    }

    if (this.client.messages.has(cacheKey, data['id'])) {
      message = <Message> this.client.messages.get(cacheKey, data['id']);
      this.client.messages.delete(cacheKey, data['id']);
    }

    this.client.emit(ClientEvents.MESSAGE_DELETE, {
      message,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_DELETE_BULK](data: GatewayRawEvents.MessageDeleteBulk) {
    const amount = data['ids'].length;
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    const messages = new BaseCollection<string, Message | null>();

    let cacheKey: null | string = null;
    switch (this.client.messages.type) {
      case MessageCacheTypes.CHANNEL: {
        cacheKey = data['channel_id'];
      }; break;
      case MessageCacheTypes.GUILD: {
        cacheKey = data['guild_id'] || data['channel_id'];
      }; break;
      case MessageCacheTypes.USER: {
        cacheKey = null;
      }; break;
    }

    for (let messageId of data['ids']) {
      if (this.client.messages.has(cacheKey, messageId)) {
        messages.set(messageId, <Message> this.client.messages.get(cacheKey, messageId));
        this.client.messages.delete(cacheKey, messageId);
      } else {
        messages.set(messageId, null);
      }
    }

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId !== undefined && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_DELETE_BULK, {
      amount,
      channel,
      channelId,
      guild,
      guildId,
      messages,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_REACTION_ADD](data: GatewayRawEvents.MessageReactionAdd) {
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let message: Message | null = null;
    const messageId = data['message_id'];
    let reaction: null | Reaction = null;
    let user: User | null = null;
    const userId = data['user_id'];

    if (this.client.users.has(userId)) {
      user = <User> this.client.users.get(userId);
    }

    const emojiId = data.emoji.id || data.emoji.name;

    let cacheKey: null | string = null;
    switch (this.client.messages.type) {
      case MessageCacheTypes.CHANNEL: {
        cacheKey = channelId;
      }; break;
      case MessageCacheTypes.GUILD: {
        cacheKey = guildId || channelId;
      }; break;
      case MessageCacheTypes.USER: {
        cacheKey = null;
      }; break;
    }

    if (this.client.messages.has(cacheKey, messageId)) {
      message = <Message> this.client.messages.get(cacheKey, messageId);
      if (message._reactions && message._reactions.has(emojiId)) {
        reaction = <Reaction> message._reactions.get(emojiId);
      }
    }

    if (!reaction) {
      reaction = new Reaction(this.client, data);
      if (message) {
        if (!message._reactions) {
          message._reactions = new BaseCollection<string, Reaction>();
        }
        message._reactions.set(emojiId, reaction);
      }
    }

    const meUserId = (this.client.user) ? this.client.user.id : null;
    reaction.merge({
      count: reaction.count + 1,
      me: (userId === meUserId) || reaction.me,
    });

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_REACTION_ADD, {
      channel,
      channelId,
      guild,
      guildId,
      message,
      messageId,
      reaction,
      user,
      userId,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_REACTION_REMOVE](data: GatewayRawEvents.MessageReactionRemove) {
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let message: Message | null = null;
    const messageId = data['message_id'];
    let reaction: null | Reaction = null;
    let user: User | null = null;
    const userId = data['user_id'];

    if (this.client.users.has(userId)) {
      user = <User> this.client.users.get(userId);
    }

    const meUserId = (this.client.user) ? this.client.user.id : null;
    const emojiId = data.emoji.id || data.emoji.name;

    let cacheKey: null | string = null;
    switch (this.client.messages.type) {
      case MessageCacheTypes.CHANNEL: {
        cacheKey = channelId;
      }; break;
      case MessageCacheTypes.GUILD: {
        cacheKey = guildId || channelId;
      }; break;
      case MessageCacheTypes.USER: {
        cacheKey = null;
      }; break;
    }

    if (this.client.messages.has(cacheKey, messageId)) {
      message = <Message> this.client.messages.get(cacheKey, messageId);
      if (message._reactions && message._reactions.has(emojiId)) {
        reaction = <Reaction> message._reactions.get(emojiId);
        reaction.merge({
          count: Math.min(reaction.count - 1, 0),
          me: reaction.me && userId !== meUserId,
        });
        if (reaction.count <= 0) {
          message._reactions.delete(emojiId);
          if (!message._reactions.length) {
            message._reactions = undefined;
          }
        }
      }
    }

    if (!reaction) {
      reaction = new Reaction(this.client, data);
    }

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_REACTION_REMOVE, {
      channel,
      channelId,
      guild,
      guildId,
      message,
      messageId,
      reaction,
      user,
      userId,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_REACTION_REMOVE_ALL](data: GatewayRawEvents.MessageReactionRemoveAll) {
    let channel: Channel | null = null;
    const channelId = data['channel_id'];
    let guild: Guild | null = null;
    const guildId = data['guild_id'];
    let message: Message | null = null;
    const messageId = data['message_id'];

    let cacheKey: null | string = null;
    switch (this.client.messages.type) {
      case MessageCacheTypes.CHANNEL: {
        cacheKey = channelId;
      }; break;
      case MessageCacheTypes.GUILD: {
        cacheKey = guildId || channelId;
      }; break;
      case MessageCacheTypes.USER: {
        cacheKey = null;
      }; break;
    }

    if (this.client.messages.has(cacheKey, messageId)) {
      message = <Message> this.client.messages.get(cacheKey, messageId);
      if (message._reactions) {
        message._reactions.clear();
        message._reactions = undefined;
      }
    }

    if (this.client.channels.has(channelId)) {
      channel = <Channel> this.client.channels.get(channelId);
    }
    if (guildId !== undefined && this.client.guilds.has(guildId)) {
      guild = <Guild> this.client.guilds.get(guildId);
    }

    this.client.emit(ClientEvents.MESSAGE_REACTION_REMOVE_ALL, {
      channel,
      channelId,
      guild,
      guildId,
      message,
      messageId,
      raw: data,
    });
  }

  [GatewayDispatchEvents.MESSAGE_UPDATE](data: GatewayRawEvents.MessageUpdate) {
    let differences: any = null;
    let isEmbedUpdate: boolean = false;
    let message: Message | null = null;

    if (!data['author']) {
      isEmbedUpdate = true;
    }

    let cacheKey: null | string = null;
    switch (this.client.messages.type) {
      case MessageCacheTypes.CHANNEL: {
        cacheKey = data['channel_id'];
      }; break;
      case MessageCacheTypes.GUILD: {
        cacheKey = data['guild_id'] || data['channel_id'];
      }; break;
      case MessageCacheTypes.USER: {
        cacheKey = null;
      }; break;
    }

    if (this.client.messages.has(cacheKey, data['id'])) {
      message = <Message> this.client.messages.get(cacheKey, data['id']);
      if (this.client.hasEventListener(ClientEvents.MESSAGE_UPDATE)) {
        differences = message.differences(data);
      }
      message.merge(data);
    } else {
      if (data['author']) {
        // else it's an embed update and we dont have it in cache
        message = new Message(this.client, data);
        this.client.messages.insert(message);
      }
    }

    this.client.emit(ClientEvents.MESSAGE_UPDATE, {
      differences,
      isEmbedUpdate,
      message,
      raw: data,
    });
  }

  [GatewayDispatchEvents.OAUTH2_TOKEN_REVOKE](data: GatewayRawEvents.Oauth2TokenRevoke) {

  }

  [GatewayDispatchEvents.PRESENCE_UPDATE](data: GatewayRawEvents.PresenceUpdate) {
    let differences: any = null;
    const guildId = data['guild_id'] || null;
    let isGuildPresence = !!guildId;
    let member: Member | null = null;
    let presence: Presence;
    let wentOffline: boolean = data['status'] === PresenceStatuses.OFFLINE;

    if (this.client.hasEventListener(ClientEvents.PRESENCE_UPDATE)) {
      if (this.client.presences.has(data['user']['id'])) {
        differences = (<Presence> this.client.presences.get(data['user']['id'])).differences(data);
      }
    }
    presence = this.client.presences.insert(data);

    if (guildId) {
      if (this.client.members.has(guildId, data['user']['id'])) {
        member = <Member> this.client.members.get(guildId, data['user']['id']);
        member.merge(data);
      } else {
        member = new Member(this.client, data);
        this.client.members.insert(member);
      }
    }

    const payload: GatewayClientEvents.PresenceUpdate = {differences, guildId, isGuildPresence, member, presence, wentOffline};
    this.client.emit(ClientEvents.PRESENCE_UPDATE, payload);
  }

  [GatewayDispatchEvents.PRESENCES_REPLACE](data: GatewayRawEvents.PresencesReplace) {
    const presences = new BaseCollection<string, Presence>();

    if (data['presences'] != null) {
      for (let raw of data['presences']) {
        // guildId is empty, use default presence cache id
        const presence = this.client.presences.insert(raw);
        presences.set(presence.user.id, presence);
      }
    }

    this.client.emit(ClientEvents.PRESENCES_REPLACE, {
      presences,
    });
  }

  [GatewayDispatchEvents.RECENT_MENTION_DELETE](data: GatewayRawEvents.RecentMentionDelete) {

  }

  [GatewayDispatchEvents.RELATIONSHIP_ADD](data: GatewayRawEvents.RelationshipAdd) {
    let differences: any = null;
    let relationship: Relationship;

    if (this.client.relationships.has(data['id'])) {
      relationship = <Relationship> this.client.relationships.get(data['id']);
      if (this.client.hasEventListener(ClientEvents.RELATIONSHIP_ADD)) {
        differences = relationship.differences(data);
      }
      relationship.merge(data);
    } else {
      relationship = new Relationship(this.client, data);
      this.client.relationships.insert(relationship);
    }

    this.client.emit(ClientEvents.RELATIONSHIP_ADD, {
      differences,
      relationship,
    });
  }

  [GatewayDispatchEvents.RELATIONSHIP_REMOVE](data: GatewayRawEvents.RelationshipRemove) {
    let relationship: Relationship;

    if (this.client.relationships.has(data['id'])) {
      relationship = <Relationship> this.client.relationships.get(data['id']);
      this.client.relationships.delete(data['id']);
    } else {
      relationship = new Relationship(this.client, data);
    }

    this.client.emit(ClientEvents.RELATIONSHIP_REMOVE, {
      id: data['id'],
      relationship,
      type: data['type'],
    });
  }

  [GatewayDispatchEvents.SESSIONS_UPDATE](data: GatewayRawEvents.SessionsUpdate) {

  }

  [GatewayDispatchEvents.STREAM_CREATE](data: GatewayRawEvents.StreamCreate) {
    this.client.emit(ClientEvents.STREAM_CREATE, {
      paused: data['paused'],
      region: data['region'],
      rtcServerId: data['rtc_server_id'],
      streamKey: data['stream_key'],
      viewerIds: data['viewer_ids'],
    });
  }

  [GatewayDispatchEvents.STREAM_DELETE](data: GatewayRawEvents.StreamDelete) {
    this.client.emit(ClientEvents.STREAM_DELETE, {
      reason: data['reason'],
      streamKey: data['stream_key'],
      unavailable: data['unavailable'],
    });
  }

  [GatewayDispatchEvents.STREAM_SERVER_UPDATE](data: GatewayRawEvents.StreamServerUpdate) {
    this.client.emit(ClientEvents.STREAM_SERVER_UPDATE, {
      endpoint: data['endpoint'],
      streamKey: data['stream_key'],
      token: data['token'],
    });
  }

  [GatewayDispatchEvents.STREAM_UPDATE](data: GatewayRawEvents.StreamUpdate) {
    this.client.emit(ClientEvents.STREAM_UPDATE, {
      paused: data['paused'],
      region: data['region'],
      streamKey: data['stream_key'],
      viewerIds: data['viewer_ids'],
    });
  }

  [GatewayDispatchEvents.TYPING_START](data: GatewayRawEvents.TypingStart) {
    const channelId = data['channel_id'];
    const guildId = data['guild_id'];
    let typing: Typing;
    const userId = data['user_id'];

    if (this.client.typings.has(channelId, userId)) {
      typing = <Typing> this.client.typings.get(channelId, userId);
      typing.merge(data);
    } else {
      typing = new Typing(this.client, data);
      this.client.typings.insert(typing);
    }

    const payload: GatewayClientEvents.TypingStart = {channelId, guildId, typing, userId};
    this.client.emit(ClientEvents.TYPING_START, payload);
  }

  [GatewayDispatchEvents.USER_ACHIEVEMENT_UPDATE](data: GatewayRawEvents.UserAchievementUpdate) {

  }

  [GatewayDispatchEvents.USER_CONNECTIONS_UPDATE](data: GatewayRawEvents.UserConnectionsUpdate) {
    // maybe fetch from rest api when this happens to keep cache up to date?
  }

  [GatewayDispatchEvents.USER_FEED_SETTINGS_UPDATE](data: GatewayRawEvents.UserFeedSettingsUpdate) {

  }

  [GatewayDispatchEvents.USER_GUILD_SETTINGS_UPDATE](data: GatewayRawEvents.UserGuildSettingsUpdate) {

  }

  [GatewayDispatchEvents.USER_NOTE_UPDATE](data: GatewayRawEvents.UserNoteUpdate) {
    let user: null | User = null;
    if (this.client.users.has(data.id)) {
      user = <User> this.client.users.get(data.id);
    }
    this.client.notes.insert(data.id, data.note);

    this.client.emit(ClientEvents.USER_NOTE_UPDATE, {
      note: data.note,
      user,
      userId: data.id,
    });
  }

  [GatewayDispatchEvents.USER_PAYMENT_SOURCES_UPDATE](data: GatewayRawEvents.UserPaymentSourcesUpdate) {
    // maybe fetch from rest api when this happens to keep cache up to date?
  }

  [GatewayDispatchEvents.USER_PAYMENTS_UPDATE](data: GatewayRawEvents.UserPaymentsUpdate) {
    // maybe fetch from rest api when this happens to keep cache up to date?
  }

  [GatewayDispatchEvents.USER_REQUIRED_ACTION_UPDATE](data: GatewayRawEvents.UserRequiredActionUpdate) {

  }

  [GatewayDispatchEvents.USER_SETTINGS_UPDATE](data: GatewayRawEvents.UserSettingsUpdate) {
    
  }

  [GatewayDispatchEvents.USER_UPDATE](data: GatewayRawEvents.UserUpdate) {
    // this updates this.client.user, us
    let differences: any = null;
    let user: UserMe;

    if (this.client.user) {
      user = this.client.user;
      if (this.client.hasEventListener(ClientEvents.USER_UPDATE)) {
        differences = user.differences(data);
      }
      user.merge(data);
    } else {
      user = new UserMe(this.client, data);
      this.client.user = user;
      this.client.users.insert(user);
    }
    this.client.emit(ClientEvents.USER_UPDATE, {differences, user});
  }

  [GatewayDispatchEvents.VOICE_SERVER_UPDATE](data: GatewayRawEvents.VoiceServerUpdate) {
    this.client.emit(ClientEvents.VOICE_SERVER_UPDATE, {
      channelId: data['channel_id'],
      endpoint: data['endpoint'],
      guildId: data['guild_id'],
      token: data['token'],
    });
  }

  [GatewayDispatchEvents.VOICE_STATE_UPDATE](data: GatewayRawEvents.VoiceStateUpdate) {
    let differences: any = null;
    let leftChannel = false;
    let voiceState: VoiceState;

    const serverId = data['guild_id'] || data['channel_id'];
    if (this.client.voiceStates.has(serverId, data['user_id'])) {
      voiceState = <VoiceState> this.client.voiceStates.get(serverId, data['user_id']);
      if (this.client.hasEventListener(ClientEvents.VOICE_STATE_UPDATE)) {
        differences = voiceState.differences(data);
      }
      voiceState.merge(data);
      if (!data['channel_id']) {
        this.client.voiceStates.delete(serverId, data['user_id']);
        leftChannel = true;
      }
    } else {
      voiceState = new VoiceState(this.client, data);
      this.client.voiceStates.insert(voiceState);
    }
    this.client.emit(ClientEvents.VOICE_STATE_UPDATE, {
      differences,
      leftChannel,
      voiceState,
    });
  }

  [GatewayDispatchEvents.WEBHOOKS_UPDATE](data: GatewayRawEvents.WebhooksUpdate) {
    this.client.emit(ClientEvents.WEBHOOKS_UPDATE, {
      channelId: data['channel_id'],
      guildId: data['guild_id'],
    });
  }
}
