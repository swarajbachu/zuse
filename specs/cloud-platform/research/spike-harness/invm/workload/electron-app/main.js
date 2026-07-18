// Minimal Electron window on the Xvfb display: renders a live clock and its
// pid so the recorded evidence visibly proves a running, post-fork app.
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
	const win = new BrowserWindow({ width: 1440, height: 900, show: true });
	win.loadURL(
		"data:text/html," +
			encodeURIComponent(`<body style="font:48px monospace;background:#111;color:#9f6">
        <h1>zuse fork spike</h1><div id=c></div><div>pid: <span id=p></span></div>
        <script>document.getElementById('p').textContent='${process.pid}';
        setInterval(()=>document.getElementById('c').textContent=new Date().toISOString(),250)</script>
        </body>`),
	);
});
