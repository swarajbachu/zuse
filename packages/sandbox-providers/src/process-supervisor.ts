/** Envd has no systemd unit. A subreaper owns descendants even after setsid. */
export const PROCESS_SUPERVISOR = `
import ctypes,os,signal,subprocess,sys,time
if ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)!=0:
    raise RuntimeError('cannot establish process ownership')
stopping=False
def stop(_signal,_frame):
    global stopping
    stopping=True
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
retirement_file,boot,start,generation,operation=sys.argv[1:6]
child=subprocess.Popen(sys.argv[6:],close_fds=True)
def descendants():
    parents={}
    for entry in os.scandir('/proc'):
        if not entry.name.isdigit(): continue
        try:
            with open(entry.path+'/stat') as handle: fields=handle.read().rsplit(') ',1)[1].split()
            parents[int(entry.name)]=(int(fields[1]),fields[0])
        except (FileNotFoundError,ProcessLookupError): pass
    owned={os.getpid()}
    while True:
        expanded=owned|{pid for pid,(parent,state) in parents.items() if parent in owned}
        if expanded==owned: break
        owned=expanded
    return {pid for pid in owned if pid!=os.getpid() and parents[pid][1]!='Z'}
def reap():
    child.poll()
    while True:
        try:
            if os.waitpid(-1,os.WNOHANG)[0]==0: break
        except ChildProcessError: break
while not stopping and child.poll() is None:
    time.sleep(0.05)
started=time.monotonic()
while True:
    reap()
    remaining=descendants()
    if not remaining: break
    for pid in remaining:
        try: os.kill(pid,signal.SIGKILL if time.monotonic()-started>0.5 else signal.SIGTERM)
        except ProcessLookupError: pass
    time.sleep(0.05)
reap()
# Only a complete retirement can authorize another generation in this boot.
# SIGKILL/OOM before this receipt leaves ownership unknown, never absent.
with open(retirement_file+'.next','w') as receipt:
    receipt.write(f'{boot} {os.getpid()} {start} {generation} {operation}\\n')
    receipt.flush()
    os.fsync(receipt.fileno())
os.replace(retirement_file+'.next',retirement_file)
directory=os.open(os.path.dirname(retirement_file),os.O_DIRECTORY)
try: os.fsync(directory)
finally: os.close(directory)
sys.exit(child.returncode or 0)
`;
