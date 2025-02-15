import { RequestTypes } from 'detritus-client-rest';

import { ShardClient } from '../client';
import { BaseCollection } from '../collections/basecollection';
import { BaseSet } from '../collections/baseset';
import { DiscordKeys, Permissions, PERMISSIONS_ALL } from '../constants';
import { PermissionTools } from '../utils';

import { BaseStructureData } from './basestructure';

import {
  ChannelGuildBase,
  ChannelGuildVoice,
} from './channel';
import { Guild } from './guild';
import { Overwrite } from './overwrite';
import { Role } from './role';
import { User, UserMixin } from './user';
import { VoiceState } from './voicestate';


const keysMember = new BaseSet<string>([
  DiscordKeys.DEAF,
  DiscordKeys.GUILD_ID,
  DiscordKeys.HOISTED_ROLE,
  DiscordKeys.JOINED_AT,
  DiscordKeys.MUTE,
  DiscordKeys.NICK,
  DiscordKeys.PREMIUM_SINCE,
  DiscordKeys.ROLES,
  DiscordKeys.USER,
]);

const keysMergeMember = new BaseSet<string>([
  DiscordKeys.GUILD_ID,
]);

/**
 * Guild Member Structure
 * @category Structure
 */
export class Member extends UserMixin {
  readonly _keys = keysMember;
  readonly _keysMerge = keysMergeMember;
  _roles?: BaseCollection<string, null | Role>;

  deaf: boolean = false;
  guildId: string = '';
  hoistedRoleId: null | string = null;
  joinedAtUnix: number = 0;
  mute: boolean = false;
  nick: null | string = null;
  premiumSinceUnix: number = 0;
  user!: User;

  constructor(client: ShardClient, data: BaseStructureData) {
    super(client);
    this.merge(data);
    Object.defineProperty(this, '_roles', {enumerable: false, writable: true});
  }

  get canAdministrator(): boolean {
    return this.can([Permissions.ADMINISTRATOR]);
  }

  get canBanMembers(): boolean {
    return this.can([Permissions.BAN_MEMBERS]);
  }

  get canChangeNickname(): boolean {
    return this.can([Permissions.CHANGE_NICKNAME]);
  }

  get canChangeNicknames(): boolean {
    return this.can([Permissions.CHANGE_NICKNAMES]);
  }

  get canCreateInstantInvite(): boolean {
    return this.can([Permissions.CREATE_INSTANT_INVITE]);
  }

  get canKickMembers(): boolean {
    return this.can([Permissions.KICK_MEMBERS]);
  }

  get canManageChannels(): boolean {
    return this.can([Permissions.MANAGE_CHANNELS]);
  }

  get canManageEmojis(): boolean {
    return this.can([Permissions.MANAGE_EMOJIS]);
  }

  get canManageGuild(): boolean {
    return this.can([Permissions.MANAGE_GUILD]);
  }

  get canManageMessages(): boolean {
    return this.can([Permissions.MANAGE_MESSAGES]);
  }

  get canManageRoles(): boolean {
    return this.can([Permissions.MANAGE_ROLES]);
  }

  get canManageWebhooks(): boolean {
    return this.can([Permissions.MANAGE_WEBHOOKS]);
  }

  get canViewAuditLogs(): boolean {
    return this.can([Permissions.VIEW_AUDIT_LOG]);
  }

  get color(): number {
    const role = this.colorRole;
    return (role) ? role.color : 0;
  }

  get colorRole(): null | Role {
    let highestRole: null | Role = null;
    for (let [roleId, role] of this.roles) {
      if (role && role.color) {
        if (highestRole) {
          if (highestRole.position < role.position) {
            highestRole = role;
          }
        } else {
          highestRole = role;
        }
      }
    }
    return highestRole;
  }

  get guild(): Guild | null {
    return this.client.guilds.get(this.guildId) || null;
  }

  get highestRole(): null | Role {
    let highestRole: null | Role = null;
    for (let [roleId, role] of this.roles) {
      if (role) {
        if (highestRole) {
          if (highestRole.position < role.position) {
            highestRole = role;
          }
        } else {
          highestRole = role;
        }
      }
    }
    return highestRole;
  }

  get hoistedRole(): null | Role {
    if (this.hoistedRoleId) {
      return this.roles.get(this.hoistedRoleId) || null;
    }
    return null;
  }

  get isBoosting(): boolean {
    return !!this.premiumSinceUnix;
  }

  get isOffline(): boolean {
    const presence = this.presence;
    if (presence) {
      return presence.isOffline;
    }
    return true;
  }

  get isOwner(): boolean {
    const guild = this.guild;
    if (guild) {
      return guild.isOwner(this.id);
    }
    return false;
  }

  get isPartial(): boolean {
    return !!this.joinedAtUnix;
  }

  get joinedAt(): Date | null {
    if (this.joinedAtUnix) {
      return new Date(this.joinedAtUnix);
    }
    return null;
  }

  get mention(): string {
    return (this.nick) ? `<@!${this.id}>` : this.user.mention;
  }

  get name(): string {
    return this.nick || this.username;
  }

  get names(): Array<string> {
    if (this.nick) {
      return [this.nick, this.username];
    }
    return [this.username];
  }

  get permissions(): number {
    if (this.isOwner) {
      return PERMISSIONS_ALL;
    }
    return this.roles.reduce((total: number, role: null | Role) => {
      if (role) {
        return total | role.permissions;
      }
      return total;
    }, Permissions.NONE);
  }

  get premiumSince(): Date | null {
    if (this.premiumSinceUnix) {
      return new Date(this.premiumSinceUnix);
    }
    return null;
  }

  get roles(): BaseCollection<string, null | Role> {
    if (this._roles) {
      return this._roles;
    }
    const collection = new BaseCollection<string, null | Role>();
    const guild = this.guild;
    collection.set(this.guildId, (guild) ? guild.defaultRole : null);
    return collection;
  }

  get voiceChannel(): ChannelGuildVoice | null {
    const voiceState = this.voiceState;
    if (voiceState) {
      return voiceState.channel;
    }
    return null;
  }

  get voiceState(): null | VoiceState {
    return this.client.voiceStates.get(this.guildId, this.id) || null;
  }

  can(
    permissions: PermissionTools.PermissionChecks,
    options: {ignoreAdministrator?: boolean, ignoreOwner?: boolean} = {},
  ): boolean {
    const guild = this.guild;
    if (guild) {
      return guild.can(permissions, this, options);
    }
    return PermissionTools.checkPermissions(this.permissions, permissions);
  }

  // canEdit(member: Member) (check the heirarchy)

  permissionsIn(channelId: ChannelGuildBase | string): number {
    let channel: ChannelGuildBase;
    if (channelId instanceof ChannelGuildBase) {
      channel = channelId;
    } else {
      if (this.client.channels.has(channelId)) {
        channel = <ChannelGuildBase> this.client.channels.get(channelId);
      } else {
        return Permissions.NONE;
      }
    }

    let total = this.permissions;
    if (channel.permissionOverwrites.has(channel.guildId)) {
      const overwrite = <Overwrite> channel.permissionOverwrites.get(channel.guildId);
      total = (total & ~overwrite.deny) | overwrite.allow;
    }

    let allow = 0, deny = 0;
    for (let [roleId, role] of this.roles) {
      if (roleId === this.guildId) {continue;}
      if (channel.permissionOverwrites.has(roleId)) {
        const overwrite = <Overwrite> channel.permissionOverwrites.get(roleId);
        allow |= overwrite.allow;
        deny |= overwrite.deny;
      }
    }
    total = (total & ~deny) | allow;

    if (channel.permissionOverwrites.has(this.id)) {
      const overwrite = <Overwrite> channel.permissionOverwrites.get(this.id);
      total = (total & ~overwrite.deny) | overwrite.allow;
    }
    return total;
  }

  addRole(roleId: string, options: RequestTypes.AddGuildMemberRole = {}) {
    return this.client.rest.addGuildMemberRole(this.guildId, this.id, roleId, options);
  }

  ban(options: RequestTypes.CreateGuildBan = {}) {
    return this.client.rest.createGuildBan(this.guildId, this.id, options);
  }

  edit(options: RequestTypes.EditGuildMember = {}) {
    return this.client.rest.editGuildMember(this.guildId, this.id, options);
  }

  editNick(nick: string, options: RequestTypes.EditGuildNick = {}) {
    if (this.isMe) {
      return this.client.rest.editGuildNick(this.guildId, nick, '@me', options);
    }
    return this.edit({...options, nick});
  }

  move(channelId: null | string, options: RequestTypes.EditGuildMember = {}) {
    return this.edit({...options, channelId});
  }

  remove(options: RequestTypes.RemoveGuildMember = {}) {
    return this.client.rest.removeGuildMember(this.guildId, this.id, options);
  }

  removeBan(options: RequestTypes.RemoveGuildBan = {}) {
    return this.client.rest.removeGuildBan(this.guildId, this.id, options);
  }

  removeRole(roleId: string, options: RequestTypes.RemoveGuildMemberRole = {}) {
    return this.client.rest.removeGuildMemberRole(this.guildId, this.id, roleId, options);
  }

  setDeaf(deaf: boolean, options: RequestTypes.EditGuildMember = {}) {
    return this.edit({...options, deaf});
  }

  setMute(mute: boolean, options: RequestTypes.EditGuildMember = {}) {
    return this.edit({...options, mute});
  }

  difference(key: string, value: any): [boolean, any] {
    let differences: any;
    switch (key) {
      case DiscordKeys.HOISTED_ROLE: {
        if (this.hoistedRoleId !== value) {
          differences = this.hoistedRoleId;
        }
      }; break;
      default: {
        return super.difference.call(this, key, value);
      };
    }
    if (differences !== undefined) {
      return [true, differences];
    }
    return [false, null];
  }

  mergeValue(key: string, value: any): void {
    if (value !== undefined) {
      switch (key) {
        case DiscordKeys.HOISTED_ROLE: {
          this.hoistedRoleId = value;
        }; return;
        case DiscordKeys.JOINED_AT: {
          this.joinedAtUnix = (value) ? (new Date(value).getTime()) : 0;
        }; return;
        case DiscordKeys.PREMIUM_SINCE: {
          this.premiumSinceUnix = (value) ? (new Date(value).getTime()) : 0;
        }; return;
        case DiscordKeys.ROLES: {
          if (value.length) {
            if (!this._roles) {
              this._roles = new BaseCollection<string, null | Role>();
            }
            this._roles.clear();
            const guild = this.guild;
            this.roles.set(this.guildId, (guild) ? guild.defaultRole : null);
            for (let roleId of value) {
              if (guild) {
                this.roles.set(roleId, guild.roles.get(roleId) || null);
              } else {
                this.roles.set(roleId, null);
              }
            }
          } else {
            if (this._roles) {
              this._roles.clear();
              this._roles = undefined;
            }
          }
        }; return;
        case DiscordKeys.USER: {
          let user: User;
          if (this.client.users.has(value.id)) {
            user = <User> this.client.users.get(value.id);
            user.merge(value);
          } else {
            user = new User(this.client, value);
            this.client.users.insert(user);
          }
          value = user;
        }; break;
      }
      return super.mergeValue.call(this, key, value);
    }
  }
}
