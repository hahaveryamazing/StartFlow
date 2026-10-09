import { createInterface } from 'node:readline';
import { loginSession } from './engine.mjs';
// Never attach a socket, inspector, logger, Playwright trace or HAR to this service.
let initialized = false,
  waiting = null,
  handler = () => {};
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const transport = {
  emit,
  onCommand: (fn) => {
    handler = fn;
  },
  password: (nonce) =>
    new Promise((resolve) => {
      waiting = { nonce, resolve };
      emit({ type: 'need_password', nonce });
    }),
};
lines.on('line', (line) => {
  if (Buffer.byteLength(line) > 32768) {
    process.exitCode = 2;
    lines.close();
    return;
  }
  try {
    const message = JSON.parse(line);
    line = '';
    if (!initialized && message.type === 'init') {
      initialized = true;
      loginSession(message, transport)
        .catch(() => {
          emit({ type: 'closed' });
          process.exitCode = 2;
        })
        .finally(() => {
          lines.close();
        });
    } else if (message.type === 'credential' && waiting && message.nonce === waiting.nonce) {
      const pending = waiting;
      waiting = null;
      pending.resolve(typeof message.password === 'string' ? message.password : null);
      message.password = null;
    } else if (message.type === 'close') {
      waiting?.resolve(null);
      waiting = null;
      void handler(message);
    } else {
      process.exitCode = 2;
      lines.close();
    }
  } catch {
    process.exitCode = 2;
    lines.close();
  }
});
lines.on('close', () => {
  waiting?.resolve(null);
  waiting = null;
  void handler({ type: 'close' });
});
process.on('uncaughtException', () => {
  process.exit(2);
});
process.on('unhandledRejection', () => {
  process.exit(2);
});
