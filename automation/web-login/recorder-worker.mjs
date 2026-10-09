import { createInterface } from 'node:readline';
import { recorderSession } from './recorder.mjs';
let initialized = false,
  handler = () => {};
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const transport = {
  emit: (e) => process.stdout.write(JSON.stringify(e) + '\n'),
  onCommand: (fn) => {
    handler = fn;
  },
};
lines.on('line', (line) => {
  try {
    if (Buffer.byteLength(line) > 16384) throw Error('invalid');
    const message = JSON.parse(line);
    if (!initialized && message.type === 'init') {
      initialized = true;
      void recorderSession(message, transport)
        .catch(() => {
          process.exitCode = 2;
        })
        .finally(() => lines.close());
    } else if (initialized && ['arm', 'test', 'manual', 'reload', 'close'].includes(message.type))
      void handler(message);
    else throw Error('invalid');
  } catch {
    process.exitCode = 2;
    lines.close();
  }
});
lines.on('close', () => void handler({ type: 'close' }));
process.on('uncaughtException', () => process.exit(2));
process.on('unhandledRejection', () => process.exit(2));
