import { ChildProcess, fork } from 'child_process';

import { EventEmitter, Timers } from 'detritus-utils';

import { ClusterManager } from '../clustermanager';
import { BaseCollection } from '../collections/basecollection';
import { ClusterIPCOpCodes } from '../constants';
import { ClusterIPCError } from '../errors';

import { ClusterIPCTypes } from './ipctypes';


export interface ClusterProcessOptions {
  clusterId: number,
  env: {[key: string]: string | undefined},
  shardCount: number,
  shardEnd: number,
  shardStart: number,
}

export interface ClusterProcessRunOptions {
  timeout?: number,
  wait?: boolean,
}

export class ClusterProcess extends EventEmitter {
  readonly _evalsWaiting = new BaseCollection<string, {
    promise: Promise<any>,
    resolve: Function,
    reject: Function,
  }>();
  readonly clusterId: number = -1;
  readonly manager: ClusterManager;

  env: {[key: string]: string | undefined} = {};
  process: ChildProcess | null = null;

  constructor(
    manager: ClusterManager,
    options: ClusterProcessOptions,
  ) {
    super();
    this.manager = manager;
    this.clusterId = options.clusterId;

    Object.assign(this.env, process.env, options.env, {
      CLUSTER_COUNT: String(this.manager.clusterCount),
      CLUSTER_ID: String(this.clusterId),
      CLUSTER_SHARD_COUNT: String(options.shardCount),
      CLUSTER_SHARD_END: String(options.shardEnd),
      CLUSTER_SHARD_START: String(options.shardStart),
    });

    Object.defineProperties(this, {
      clusterId: {writable: false},
      manager: {enumerable: false, writable: false},
    });
  }

  get file(): string {
    return this.manager.file;
  }

  async onMessage(
    message: ClusterIPCTypes.IPCMessage | any,
  ): Promise<void> {
    // our child has sent us something
    if (message && typeof(message) === 'object') {
      try {
        switch (message.op) {
          case ClusterIPCOpCodes.READY: {
            this.emit('ready');
          }; return;
          case ClusterIPCOpCodes.CLOSE: {
            const data: ClusterIPCTypes.Close = message.data;
            this.emit('shardClose', {...data, shardId: message.shard});
          }; return;
          case ClusterIPCOpCodes.RECONNECTING: {
            this.emit('shardReconnecting');
          }; return;
          case ClusterIPCOpCodes.RESPAWN_ALL: {

          }; return;
          case ClusterIPCOpCodes.EVAL: {
            if (message.request) {
              const data: ClusterIPCTypes.Eval = message.data;
              try {
                const results = await this.manager.broadcastEvalRaw(
                  data.code,
                  data.nonce,
                );
                await this.sendIPC(ClusterIPCOpCodes.EVAL, {
                  ...data,
                  results,
                });
              } catch(error) {
                await this.sendIPC(ClusterIPCOpCodes.EVAL, {
                  ...data,
                  error: {
                    message: error.message,
                    name: error.name,
                    stack: error.stack,
                  },
                });
              }
            }
          }; return;
        }
      } catch(error) {
        this.emit('warn', error);
      }
    }
    this.emit('message', message);
  }

  async onExit(code: number, signal: string): Promise<void> {
    this.emit('close', {code, signal});
    Object.defineProperty(this, 'ran', {value: false});
    this.process = null;

    for (let [nonce, item] of this._evalsWaiting) {
      item.resolve([new Error(`Process has closed with '${code}' code and '${signal}' signal.`), true]);
      this._evalsWaiting.delete(nonce);
    }

    if (this.manager.respawn) {
      try {
        await this.run();
      } catch(error) {
        this.emit('warn', error);
      }
    }
  }

  async eval(
    code: Function | string,
    nonce: string,
  ): Promise<[any, boolean] | null> {
    if (this.process === null) {
      throw new Error('Cannot eval without a child!');
    }
    if (this._evalsWaiting.has(nonce)) {
      return <Promise<[any, boolean] | null>> (<any> this._evalsWaiting.get(nonce)).promise;
    }
    // incase the process dies
    const child = this.process;

    return new Promise((resolve, reject) => {
      const promise: Promise<[any, boolean] | null> = new Promise(async (res, rej) => {
        const listener = (
          message: ClusterIPCTypes.IPCMessage | any,
        ) => {
          if (message && typeof(message) === 'object') {
            switch (message.op) {
              case ClusterIPCOpCodes.EVAL: {
                const data: ClusterIPCTypes.Eval = message.data;
                if (data.nonce === nonce) {
                  child.removeListener('message', listener);
                  this._evalsWaiting.delete(nonce);
  
                  if (data.ignored) {
                    res(null);
                  } else {
                    if (data.error) {
                      res([data.error, true]);
                    } else {
                      res([data.result, false]);
                    }
                  }
                }
              }; break;
            }
          }
        };
        child.addListener('message', listener);
  
        if (typeof(code) === 'function') {
          code = `(${String(code)})(this)`;
        }
        try {
          await this.sendIPC(ClusterIPCOpCodes.EVAL, {code, nonce}, true);
        } catch(error) {
          child.removeListener('message', listener);
          rej(error);
        }
      });

      this._evalsWaiting.set(nonce, {promise, resolve, reject});
      promise.then(resolve).catch(reject);
    });
  }

  async send(message: any): Promise<void> {
    if (this.process != null) {
      const child = this.process;
      await new Promise((resolve, reject) => {
        child.send(message, (error: any) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
  }

  async sendIPC(
    op: number,
    data: any = null,
    request: boolean = false,
    shard?: number,
  ): Promise<void> {
    return this.send({op, data, request, shard});
  }

  async run(
    options: ClusterProcessRunOptions = {},
  ): Promise<ChildProcess> {
    if (this.process) {
      return this.process;
    }
    const process = fork(this.file, [], {
      env: this.env,
    });
    this.process = process;
    this.process.on('message', this.onMessage.bind(this));
    this.process.on('exit', this.onExit.bind(this));

    if (options.wait || options.wait === undefined) {
      return new Promise((resolve, reject) => {
        const timeout = new Timers.Timeout();
        if (options.timeout) {
          timeout.start(options.timeout, () => {
            if (this.process === process) {
              this.process.kill();
              this.process = null;
            }
            reject(new Error('Cluster Child took too long to ready up'));
          });
        }
        this.once('ready', () => {
          timeout.stop();
          resolve(process);
        });
      });
    }
    return process;
  }
}
