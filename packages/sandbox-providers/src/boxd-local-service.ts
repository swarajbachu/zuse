/** Keep the service bearer inside the guest; return only the service response. */
export const BOXD_LOCAL_SERVICE_CLIENT = `
const http = require('node:http');
const fs = require('node:fs');
try {
 const input = JSON.parse(process.argv[1]);
 const descriptor = JSON.parse(fs.readFileSync(input.descriptorPath, 'utf8'));
 if (descriptor.incarnation !== input.expectedIncarnation || descriptor.port !== input.port || typeof descriptor.token !== 'string' || descriptor.token.length !== 43) process.exit(2);
 const request = http.request({hostname:'127.0.0.1', port:input.port, path:input.path, method:'POST', headers:{authorization:'Bearer '+descriptor.token,'content-type':'application/json','content-length':Buffer.byteLength(input.body)}}, response => {
   if (response.statusCode !== 200) process.exit(2);
   let bytes = 0; const chunks = [];
   response.on('data', chunk => {bytes += chunk.length; if (bytes > 2097152) process.exit(2); chunks.push(chunk);});
   response.on('error', () => process.exit(2));
   response.on('end', () => {clearTimeout(timer); process.stdout.write(Buffer.concat(chunks));});
 });
 const timer = setTimeout(() => {request.destroy(); process.exit(2);}, 25000);
 request.on('error', () => process.exit(2));
 request.end(input.body);
} catch { process.exit(2); }
`;
