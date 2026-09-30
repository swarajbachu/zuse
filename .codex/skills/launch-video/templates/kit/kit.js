/* Zuse × boxd film kit — deterministic motion helpers shared by every frame.
   Everything here is a pure function of timeline time: no clocks, no randomness,
   no state between frames. Requires GSAP (loaded by index.html) and icons.js. */
(() => {
	const ZK = {};

	/* ---------- springs (closed-form step responses) ---------- */
	/** Underdamped step response 0 → 1 at time t (s). zeta < 1 overshoots. */
	ZK.spring = (t, zeta = 0.62, w = 16) => {
		if (t <= 0) return 0;
		if (zeta >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
		const wd = w * Math.sqrt(1 - zeta * zeta);
		return (
			1 -
			Math.exp(-zeta * w * t) *
				(Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t))
		);
	};
	/** GSAP ease for a tween of `dur` seconds that follows the spring and lands exactly on 1. */
	ZK.springEase = (dur, zeta = 0.62, w = 16) => {
		const end = ZK.spring(dur, zeta, w);
		return (p) => {
			const v = ZK.spring(p * dur, zeta, w);
			return v + (1 - end) * p; // pin the final value to 1
		};
	};
	ZK.ease = {
		pop: (d) => ZK.springEase(d, 0.5, 18),
		soft: (d) => ZK.springEase(d, 0.78, 13),
		snap: (d) => ZK.springEase(d, 0.9, 26),
	};

	/* ---------- icons ---------- */
	/** Inline app icon. kind: "hg" (hugeicons, stroke 1), "lu" (lucide), "px" (dither cloud). */
	ZK.icon = (name, size = 14, extra = "") => {
		const svg = window.ZK_ICONS?.[name] || "";
		const kind =
			name === "DitherCloud"
				? "px"
				: /^(Chevron|RefreshCw|LoaderCircle|Plus|Check|X|Cloud|MousePointerClick|Camera)/.test(
							name,
						)
					? "lu"
					: "hg";
		const chev = name.startsWith("Chevron") ? " chev" : "";
		return `<span class="zi ${kind}${chev} ${extra}" style="width:${size}px;height:${size}px">${svg}</span>`;
	};

	/* ---------- boxd notch shape ---------- */
	/** SVG path: rounded rect (radius r) with boxd's logo bite at the bottom-left corner.
	 *  n = bite size (0 = plain rounded rect). Proportions follow assets/boxd-mark.svg. */
	ZK.notchPath = (w, h, r, n) => {
		r = Math.max(0, Math.min(r, w / 2, h / 2));
		if (!n || n < 0.5) {
			return `M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}H${r}A${r} ${r} 0 0 1 0 ${h - r}V${r}A${r} ${r} 0 0 1 ${r} 0Z`;
		}
		n = Math.min(n, w * 0.45, h * 0.45);
		const f = Math.min(n * 0.42, r); // fillet radius at the bite's corners
		const bx = n,
			by = h - n; // inner corner of the bite
		return [
			`M${r} 0H${w - r}A${r} ${r} 0 0 1 ${w} ${r}`,
			`V${h - r}A${r} ${r} 0 0 1 ${w - r} ${h}`,
			`H${bx + f}A${f} ${f} 0 0 1 ${bx} ${h - f}`, // convex, bottom edge → bite wall
			`V${by + f}A${f} ${f} 0 0 0 ${bx - f} ${by}`, // concave inner corner
			`H${f}A${f} ${f} 0 0 1 0 ${by - f}`, // convex, bite ceiling → left edge
			`V${r}A${r} ${r} 0 0 1 ${r} 0Z`,
		].join("");
	};

	/** A morphable boxd shape. state = {x,y,w,h,r,n,fill}. Call .render() after mutating state
	 *  (morph() does this from onUpdate, so it re-draws on every seek). */
	ZK.Shape = function (parent, state) {
		const NS = "http://www.w3.org/2000/svg";
		this.svg = document.createElementNS(NS, "svg");
		this.svg.setAttribute("class", "zk-shape");
		this.path = document.createElementNS(NS, "path");
		this.svg.appendChild(this.path);
		parent.appendChild(this.svg);
		this.s = Object.assign(
			{ x: 0, y: 0, w: 100, h: 100, r: 12, n: 0, fill: "#0A0C12", opacity: 1 },
			state,
		);
		this.render();
	};
	ZK.Shape.prototype.render = function () {
		const s = this.s;
		this.svg.setAttribute("width", Math.max(1, s.w));
		this.svg.setAttribute("height", Math.max(1, s.h));
		this.svg.style.transform = `translate(${s.x}px, ${s.y}px)`;
		this.svg.style.opacity = s.opacity;
		this.path.setAttribute("d", ZK.notchPath(s.w, s.h, s.r, s.n));
		this.path.setAttribute("fill", s.fill);
	};
	/** Tween a Shape to `to` (any of x,y,w,h,r,n,opacity) on timeline tl at time t. */
	ZK.morph = (tl, shape, t, dur, to, ease) => {
		tl.to(
			shape.s,
			Object.assign(
				{
					duration: dur,
					ease: ease || ZK.ease.soft(dur),
					onUpdate: () => shape.render(),
				},
				to,
			),
			t,
		);
		return tl;
	};
	/** Flood: grow a shape past the frame corners (overscaled so no half-frame pop), ~0.3s. */
	ZK.flood = (tl, shape, t, W, H, dur = 0.32) => {
		const pad = Math.max(W, H) * 0.25;
		// power1.out: the shape is small early, so fast early growth keeps per-frame screen change even.
		return ZK.morph(
			tl,
			shape,
			t,
			dur,
			{ x: -pad, y: -pad, w: W + pad * 2, h: H + pad * 2, r: 0, n: 0 },
			"power1.out",
		);
	};

	/* ---------- cursor ---------- */
	const CURSOR_SVG =
		'<svg viewBox="0 0 26 38"><path d="M3 3v26l7.2-6.9 4.6 10.9 4.7-2-4.6-10.6h9.9z" fill="#0E0F11" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>';
	/** Create a cursor (and its click ring) inside `parent`. The cursor's hotspot is its tip. */
	ZK.cursor = (parent, x = 0, y = 0, opts = {}) => {
		const ring = document.createElement("div");
		ring.className = `zk-ring${opts.onDark ? " on-dark" : ""}`;
		const el = document.createElement("div");
		el.className = "zk-cursor";
		el.innerHTML = CURSOR_SVG;
		parent.appendChild(ring);
		parent.appendChild(el);
		gsap.set(el, { x: x - 3, y: y - 3 });
		gsap.set(ring, { x, y });
		return { el, ring, x, y };
	};
	/** Glide the cursor tip to (x, y). */
	ZK.cursorTo = (tl, c, t, dur, x, y, ease = "power3.inOut") => {
		tl.to(c.el, { x: x - 3, y: y - 3, duration: dur, ease }, t);
		tl.set(c.ring, { x, y }, t + dur);
		return tl;
	};
	/** A real click at time t: press (scale .86), release on a spring, stroke ring expands and clears. */
	ZK.click = (tl, c, t) => {
		tl.to(c.el, { scale: 0.86, duration: 0.07, ease: "power2.out" }, t);
		tl.to(c.el, { scale: 1, duration: 0.3, ease: ZK.ease.pop(0.3) }, t + 0.07);
		// immediateRender:false — otherwise fromTo paints the ring's start state (visible) at time 0.
		tl.fromTo(
			c.ring,
			{ scale: 0.3, opacity: 0.55 },
			{
				scale: 1.25,
				opacity: 0,
				duration: 0.42,
				ease: "power2.out",
				immediateRender: false,
			},
			t + 0.02,
		);
		return tl;
	};

	/* ---------- text + element motion ---------- */
	/** Text rises out of a mask line. el = the .zk-rise inside a .zk-mask. */
	ZK.rise = (tl, el, t, dur = 0.55, from = 110) => {
		tl.fromTo(
			el,
			{ yPercent: from },
			{ yPercent: 0, duration: dur, ease: ZK.ease.soft(dur) },
			t,
		);
		return tl;
	};
	/** Reverse of rise: text sinks back below its mask line. */
	ZK.sink = (tl, el, t, dur = 0.35) => {
		tl.to(el, { yPercent: 110, duration: dur, ease: "power3.in" }, t);
		return tl;
	};
	/** Pop from zero on a spring. */
	ZK.pop = (tl, el, t, dur = 0.5, from = 0) => {
		tl.fromTo(
			el,
			{ scale: from },
			{ scale: 1, duration: dur, ease: ZK.ease.pop(dur) },
			t,
		);
		return tl;
	};
	/** Deterministic typing: reveals `text` into el over dur (characters by progress). */
	ZK.type = (tl, el, text, t, dur) => {
		const o = { p: 0 };
		el.textContent = "";
		tl.to(
			o,
			{
				p: 1,
				duration: dur,
				ease: "none",
				onUpdate: () =>
					(el.textContent = text.slice(0, Math.round(o.p * text.length))),
			},
			t,
		);
		return tl;
	};

	/* ---------- camera ---------- */
	/** Screen-Studio style camera on a stage element (transform-origin 0 0).
	 *  Frames the stage point (cx, cy) at viewport centre (VW/2, VH/2) with zoom `scale`. */
	ZK.camera = (tl, stage, t, dur, cx, cy, scale, VW, VH, ease) => {
		tl.to(
			stage,
			{
				x: VW / 2 - cx * scale,
				y: VH / 2 - cy * scale,
				scale,
				duration: dur,
				ease: ease || ZK.ease.soft(dur),
			},
			t,
		);
		return tl;
	};
	ZK.cameraSet = (stage, cx, cy, scale, VW, VH) => {
		gsap.set(stage, {
			transformOrigin: "0 0",
			x: VW / 2 - cx * scale,
			y: VH / 2 - cy * scale,
			scale,
		});
	};

	/* ---------- layout ---------- */
	/** "wide" (16:9 master) or "square" (1:1 cut), from the composition's canvas size. */
	ZK.aspect = (root) => {
		// index.html declares the canvas once (window.ZK_FORMAT) so every frame agrees on it.
		const f = window.ZK_FORMAT || {};
		const w = f.W || root.clientWidth || 1920;
		const h = f.H || root.clientHeight || 1080;
		const a = w / h > 1.2 ? "wide" : "square";
		root.dataset.aspect = a;
		// The runtime copies a frame root's authored data-width/height (1920×1080) onto its host slot,
		// so size the root and its own host to the real canvas — otherwise the square cut is uncovered
		// below y=1080 and clip insets are computed against the wrong box.
		const id = root.getAttribute("data-composition-id");
		for (const el of [root, root.parentElement]) {
			if (!el || (el !== root && el.getAttribute("data-composition-id") !== id))
				continue;
			el.style.width = `${w}px`;
			el.style.height = `${h}px`;
		}
		return { aspect: a, W: w, H: h };
	};

	window.ZK = ZK;
})();
