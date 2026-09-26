// SSH carries only setup and a small descriptor. Compressed bytes are read via
// the existing authenticated workspace file RPC, in parts below its 5 MB cap.
export const ARCHIVE_SNAPSHOT_SCRIPT = `
import sys, json, subprocess, gzip, tempfile, os, signal, base64
config = json.loads(sys.stdin.readline())
process = None
def stop(*args):
 if process is not None and process.poll() is None: process.kill()
 raise SystemExit(1)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGALRM, stop)
signal.alarm(600)
with tempfile.TemporaryDirectory(prefix='zuse-sync-', dir='/tmp') as scratch:
 process = subprocess.Popen([sys.executable, '-c', config['script'], config['root']], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
 try:
  process.stdin.write(gzip.decompress(base64.b64decode(config['baseline']))); process.stdin.close()
  archive_path = os.path.join(scratch, 'archive')
  with open(archive_path, 'wb') as archive:
   with gzip.GzipFile(fileobj=archive, mode='wb', compresslevel=1) as output:
    while True:
     chunk = process.stdout.read(1048576)
     if not chunk: break
     output.write(chunk)
  if process.wait() != 0: raise RuntimeError('Snapshot producer failed')
  parts = []
  with open(archive_path, 'rb') as archive:
   while True:
    chunk = archive.read(4 * 1024 * 1024)
    if not chunk: break
    path = os.path.join(scratch, 'part-' + str(len(parts)))
    with open(path, 'wb') as part: part.write(chunk)
    parts.append(path)
  os.unlink(archive_path)
  print(json.dumps(dict(parts=parts)), flush=True)
  if sys.stdin.readline().strip() != 'done': raise RuntimeError('Snapshot cancelled')
 finally:
  if process.poll() is None: process.kill()
  process.wait()
`;
