// Executed by the Box command channel. Hosted ports target a VM interface,
// while workspace runtimes intentionally bind loopback. Repeated resolution
// keeps existing listeners and starts only missing interface forwarders.
export const BOX_PORT_FORWARDER = `
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const port = Number(process.argv[1]);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
if (process.argv[2] !== 'daemon') {
  const child = spawn(process.execPath, ['-e', process._eval, String(port), 'daemon'], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const timer = setTimeout(() => { child.kill(); process.exit(1); }, 10000);
  child.once('error', () => process.exit(1));
  child.once('exit', code => { clearTimeout(timer); process.exit(code ?? 1); });
  child.once('message', message => {
    clearTimeout(timer);
    child.disconnect();
    child.unref();
    process.exit(message === 'ready' ? 0 : 1);
  });
} else {
  const addresses = [...new Set(Object.values(os.networkInterfaces()).flat()
    .filter(i => i && !i.internal && i.family === 'IPv4').map(i => i.address))];
  if (!addresses.length) process.exit(1);
  Promise.all(addresses.map(host => new Promise((resolve, reject) => {
    const server = net.createServer({ allowHalfOpen: true }, incoming => {
      const upstream = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
      const close = () => { incoming.destroy(); upstream.destroy(); };
      upstream.setTimeout(10000, close);
      upstream.once('connect', () => upstream.setTimeout(0));
      incoming.on('error', close);
      upstream.on('error', close);
      incoming.on('close', () => upstream.destroy());
      upstream.on('close', hadError => hadError ? incoming.destroy() : incoming.end());
      incoming.pipe(upstream).pipe(incoming);
    });
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
    server.listen({ host, port }, resolve);
  }))).then(() => process.send('ready'), () => process.exit(1));
}
`;
