import {
	BOXD_RUNTIME_PROTOCOL,
	BOXD_RUNTIME_SOCKET,
} from "@zuse/utils/boxd-runtime-protocol";

/** Tiny exec client: never import the application bundle on the activation path. */
export const BOXD_RUNTIME_CLIENT = `
const net = require('node:net');
const request = JSON.parse(process.argv[1]);
const socket = net.connect(${JSON.stringify(BOXD_RUNTIME_SOCKET)});
const timer = setTimeout(() => { socket.destroy(); process.exit(2); }, 15000);
let bytes = '';
socket.once('connect', () => socket.write(JSON.stringify(request) + '\\n'));
socket.on('data', chunk => {
  bytes += chunk;
  if (bytes.length > 4096) process.exit(2);
  if (!bytes.includes('\\n')) return;
  clearTimeout(timer);
  try {
    const reply = JSON.parse(bytes.trim());
    if (reply.version !== ${BOXD_RUNTIME_PROTOCOL}) process.exit(2);
    if (reply.state === 'cold') process.exit(4);
    if (!['prepared', 'active'].includes(reply.state)) process.exit(2);
    process.stdout.write(reply.state);
    socket.destroy();
  } catch { process.exit(2); }
});
socket.once('error', error => { clearTimeout(timer); process.exit(['ENOENT', 'ECONNREFUSED'].includes(error.code) ? 3 : 2); });
socket.once('end', () => { if (!bytes.includes('\\n')) process.exit(2); });
`;
