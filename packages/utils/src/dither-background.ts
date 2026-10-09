/**
 * Animated dithered-wave backdrop for the browser-facing connect pages (the
 * desktop sign-in loopback and the api's integration pages). A dependency-free,
 * single-pass WebGL port of React Bits' "Dither" background
 * (reactbits.dev/backgrounds/dither): fbm Perlin waves, an 8×8 Bayer dither,
 * and waves that part around the pointer. It's progressive enhancement: the
 * page's `.stage::before` fallback stays until WebGL draws, motion stops for
 * reduced-motion users, and the loop pauses while the tab is hidden. Pages
 * allow exactly this script by hash, so the CSP still forbids anything else.
 */

import { createHash } from "node:crypto";

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 resolution;
uniform vec2 pointer;
uniform float time;
uniform vec3 ink;
uniform vec3 paper;
const float PIXEL = 3.0;
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
vec2 fade(vec2 t){return t*t*t*(t*(t*6.0-15.0)+10.0);}
float cnoise(vec2 P){
	vec4 Pi=mod289(floor(P.xyxy)+vec4(0.0,0.0,1.0,1.0));
	vec4 Pf=fract(P.xyxy)-vec4(0.0,0.0,1.0,1.0);
	vec4 i=permute(permute(Pi.xzxz)+Pi.yyww);
	vec4 gx=fract(i*(1.0/41.0))*2.0-1.0;
	vec4 gy=abs(gx)-0.5;
	gx-=floor(gx+0.5);
	vec2 g00=vec2(gx.x,gy.x),g10=vec2(gx.y,gy.y),g01=vec2(gx.z,gy.z),g11=vec2(gx.w,gy.w);
	vec4 n=taylorInvSqrt(vec4(dot(g00,g00),dot(g01,g01),dot(g10,g10),dot(g11,g11)));
	g00*=n.x;g01*=n.y;g10*=n.z;g11*=n.w;
	vec2 f=fade(Pf.xy);
	vec2 x=mix(vec2(dot(g00,Pf.xy),dot(g01,vec2(Pf.x,Pf.w))),vec2(dot(g10,vec2(Pf.z,Pf.y)),dot(g11,Pf.zw)),f.x);
	return 2.3*mix(x.x,x.y,f.y);
}
float fbm(vec2 p){
	float v=0.0,a=1.0;
	for(int i=0;i<4;i++){v+=a*abs(cnoise(p));p*=3.0;a*=0.3;}
	return v;
}
float bayer2(vec2 a){a=floor(a);return fract(a.x/2.0+a.y*a.y*0.75);}
float bayer8(vec2 a){
	return bayer2(0.25*a)*0.0625+bayer2(0.5*a)*0.25+bayer2(a);
}
void main(){
	vec2 cell=floor(gl_FragCoord.xy/PIXEL);
	vec2 uv=(cell*PIXEL+0.5*PIXEL)/resolution-0.5;
	uv.x*=resolution.x/resolution.y;
	float f=fbm(uv+fbm(uv-time*0.05));
	vec2 m=(pointer/resolution-0.5)*vec2(1.0,-1.0);
	m.x*=resolution.x/resolution.y;
	f-=0.5*(1.0-smoothstep(0.0,0.6,length(uv-m)));
	// Calm the centre so the stamp and copy stay legible.
	f*=mix(0.35,1.0,smoothstep(0.1,0.75,length(uv)));
	// Ordered dither to four tones between paper and ink.
	float level=min(floor(clamp(f,0.0,1.0)*3.0+bayer8(cell)),3.0)/3.0;
	gl_FragColor=vec4(mix(paper,ink,level),1.0);
}`;

const SCRIPT = `(()=>{
const canvas=document.createElement("canvas");
canvas.className="dither";
canvas.setAttribute("aria-hidden","true");
const gl=canvas.getContext("webgl",{antialias:false,alpha:false,powerPreference:"low-power"});
if(!gl)return;
const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);return gl.getShaderParameter(s,gl.COMPILE_STATUS)?s:null;};
const vs=shader(gl.VERTEX_SHADER,"attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}");
const fs=shader(gl.FRAGMENT_SHADER,${JSON.stringify(FRAGMENT_SHADER)});
if(!vs||!fs)return;
const program=gl.createProgram();
gl.attachShader(program,vs);gl.attachShader(program,fs);gl.linkProgram(program);
if(!gl.getProgramParameter(program,gl.LINK_STATUS))return;
gl.useProgram(program);
gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
const u=n=>gl.getUniformLocation(program,n);
const dark=matchMedia("(prefers-color-scheme: dark)");
const still=matchMedia("(prefers-reduced-motion: reduce)");
const pointer=[-1e4,-1e4];
const theme=()=>{const d=dark.matches;gl.uniform3f(u("paper"),...(d?[.051,.051,.051]:[.957,.957,.949]));gl.uniform3f(u("ink"),...(d?[.24,.24,.23]:[.8,.8,.77]));};
const size=()=>{canvas.width=innerWidth;canvas.height=innerHeight;gl.viewport(0,0,canvas.width,canvas.height);gl.uniform2f(u("resolution"),canvas.width,canvas.height);};
let frame=0;
const start=performance.now();
const draw=now=>{gl.uniform1f(u("time"),still.matches?0:(now-start)/1000);gl.uniform2f(u("pointer"),pointer[0],pointer[1]);gl.drawArrays(gl.TRIANGLES,0,3);frame=still.matches||document.hidden?0:requestAnimationFrame(draw);};
const wake=()=>{if(!frame)frame=requestAnimationFrame(draw);};
addEventListener("resize",()=>{size();wake();});
addEventListener("pointermove",e=>{pointer[0]=e.clientX;pointer[1]=e.clientY;wake();});
dark.addEventListener("change",()=>{theme();wake();});
still.addEventListener("change",wake);
document.addEventListener("visibilitychange",wake);
theme();size();
document.body.prepend(canvas);
document.documentElement.classList.add("dithered");
wake();
})();`;

export const DITHER_BACKGROUND_SCRIPT = `<script>${SCRIPT}</script>`;

export const DITHER_BACKGROUND_STYLES = `
.dither{
	position:fixed;inset:0;z-index:0;width:100vw;height:100vh;pointer-events:none;
	image-rendering:pixelated;animation:dither-in .9s ease-out both;
}
.dithered .stage::before{display:none}
@keyframes dither-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.dither{animation:none}}
`;

/** CSP source for the inline dither script; nothing else may execute. */
export const DITHER_BACKGROUND_SCRIPT_SOURCE = `'sha256-${createHash("sha256").update(SCRIPT).digest("base64")}'`;
