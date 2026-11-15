import net from 'node:net';

declare module 'node:net' {
  interface Socket {
    /** Node 24's IP type of service, which the @types/node this repository pins does not declare yet. */
    setTypeOfService?(typeOfService: number): this;
  }
}

/** Marks the socket prototype once its refusal is ignored, so a second call wraps nothing again. */
const IGNORED = Symbol.for('teamai.typeOfServiceRefusalIgnored');

/**
 * Makes setting a socket's type of service best-effort for the whole process, as undici 7.30 does itself. Node's own
 * fetch (undici 7.29 in Node 24.21) sets it on each request's socket as it connects, without a guard, so a socket the
 * peer reset first refuses with EINVAL out of the connect event, and the process ends with an uncaught exception
 * instead of the request failing. Only that refusal is ignored; the request still fails on the reset connection.
 */
export function ignoreTypeOfServiceRefusal(): void {
  const prototype = net.Socket.prototype;
  // Node before 24 has no setTypeOfService, so nothing sets a type of service there.
  const set = prototype.setTypeOfService;

  if (set === undefined || Object.hasOwn(prototype, IGNORED)) return;

  prototype.setTypeOfService = function setTypeOfServiceIfAccepted(this: net.Socket, typeOfService: number): net.Socket {
    try {
      return set.call(this, typeOfService);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EINVAL') return this;

      throw error;
    }
  };

  Object.defineProperty(prototype, IGNORED, { value: true });
}
