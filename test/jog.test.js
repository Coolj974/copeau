import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jogPlan, travelled, segmentsDue, segmentAxes, MAX_BLOCKS } from '../public/js/shared/jog.js';

const GRBL = { 110: 3000, 111: 3000, 112: 1000, 120: 200, 121: 200, 122: 100 };

test('jog maintenu : même vitesse que le pas répété toutes les 40 ms', () => {
  const fine = jogPlan({ X: 1 }, { step: 0.01, feed: 2000, settings: GRBL });
  assert.equal(fine.stepRate, 2000);
  assert.equal(fine.rate, 15);
  assert.equal(fine.continuesStep, false);
  const mm = jogPlan({ X: -1 }, { step: 1, feed: 2000, settings: GRBL });
  assert.equal(mm.rate, 1500);
  const big = jogPlan({ Y: 1 }, { step: 10, feed: 2000, settings: GRBL });
  assert.equal(big.rate, 2000);
  assert.equal(big.continuesStep, true);
});

test('jog : vitesse et accélération limitées par l\'axe le plus contraignant', () => {
  const z = jogPlan({ Z: 1 }, { step: 10, feed: 5000, settings: GRBL });
  assert.equal(z.stepRate, 1000);
  assert.equal(z.accel, 100);
  const diag = jogPlan({ X: 1, Y: 1 }, { step: 10, feed: 9000, settings: { ...GRBL, 110: 1000 } });
  assert.equal(diag.stepRate, Math.round(1000 * Math.SQRT2));
  const axes = segmentAxes(diag);
  assert.ok(Math.abs(Math.hypot(axes.X, axes.Y) - diag.segment) < 1e-9);
  assert.ok(axes.X > 0 && axes.Y > 0);
});

test('jog continu : toujours la distance de freinage devant l\'outil, jamais trop', () => {
  for (const [step, feed] of [[0.1, 2000], [1, 2000], [10, 3000], [10, 500]]) {
    const plan = jogPlan({ X: 1 }, { step, feed, settings: GRBL });
    const v = plan.rate / 60;
    assert.ok(plan.lead / plan.segment <= MAX_BLOCKS + 1e-9);
    assert.equal(Math.round(plan.segment * 1000), plan.segment * 1000);
    // Pompe toutes les 25 ms, segments acquittés aussitôt.
    let sent = 0;
    for (let t = 0; t <= 3; t += 0.025) {
      sent += segmentsDue(plan, t, sent, 0) * plan.segment;
      const speed = Math.min(v, plan.accel * t);
      const ahead = sent - travelled(t, v, plan.accel);
      assert.ok(ahead >= (speed * speed) / (2 * plan.accel), `pas ${step} : ${ahead} devant à ${t}s`);
      assert.ok(ahead <= plan.lead + 2 * plan.segment, `pas ${step} : trop d'avance à ${t}s`);
    }
  }
});

test('jog continu : segments en route plafonnés', () => {
  const plan = jogPlan({ X: 1 }, { step: 1, feed: 2000, settings: GRBL });
  assert.equal(segmentsDue(plan, 0, 0, 0), 2);
  assert.equal(segmentsDue(plan, 0, 0, 2), 0);
  assert.equal(segmentsDue(plan, 0, plan.lead, 0), 0);
  assert.equal(travelled(0, 25, 200), 0);
  const knee = 25 / 200;
  assert.ok(Math.abs(travelled(knee - 1e-9, 25, 200) - travelled(knee + 1e-9, 25, 200)) < 1e-6);
});
