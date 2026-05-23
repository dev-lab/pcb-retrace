// ── Undo history ─────────────────────────────────────────────
// Kept separate to avoid circular imports between interaction.js and ui.js.
import { S }				 from './state.js';
import { routeWires } from './layout.js';
import { render }			from './draw.js';

export function pushHistory() {
	S.history.push(JSON.stringify(
		S.components.map(c => ({ id: c.id, x: c.x, y: c.y, rotation: c.rotation, flipX: c.flipX }))
	));
	if (S.history.length > 60) S.history.shift();
}

export function undo() {
	if (!S.history.length) {
		import('./ui.js').then(({ toast }) => toast('Nothing to undo', 'warn'));
		return;
	}
	JSON.parse(S.history.pop()).forEach(s => {
		const c = S.components.find(x => x.id === s.id);
		if (!c) return;
		c.x = s.x; c.y = s.y; c.rotation = s.rotation; c.flipX = s.flipX;
	});
	// routeWires() fully syncs all geometry (including restored rotations)
	// and positions into WireBender before calling routeAll().
	routeWires();
	import('./ui.js').then(({ toast }) => toast('Undone'));
}
