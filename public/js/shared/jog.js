// Jog continu fluide pour Grbl, selon la méthode du wiki Grbl (« Joystick
// Implementation ») : de courts déplacements G91 envoyés au fil du temps, avec
// juste assez d'avance dans le planificateur pour tenir la vitesse.
//
// Grbl planifie toujours un arrêt au bout de ce qu'il a reçu. Avec moins que
// la distance de freinage v²/2a devant l'outil, il ralentit puis repart à
// chaque commande : le mouvement est saccadé. Au relâchement, le jog cancel
// vide le planificateur : cette avance ne fait pas dépasser.

const AXES = ['X', 'Y', 'Z'];
// Appui maintenu : au plus un pas toutes les 40 ms. Les petits pas donnent une
// approche lente (0,01 mm → 15 mm/min), utile pour prendre un zéro.
export const JOG_REPEAT_MS = 40;
// Avance en plus de la distance de freinage, pour absorber la latence.
const MARGIN_S = 0.15;
// Blocs d'avance au plus : Grbl n'en garde que 15. Planificateur plein, une
// ligne reçue attend sa place et s'exécute après l'annulation : dépassement.
export const MAX_BLOCKS = 6;
const MIN_SEGMENT_S = 0.1;
const MIN_SEGMENT_MM = 0.01;
// $120 par défaut de Grbl : prudent si les réglages ne sont pas encore lus.
const DEFAULT_ACCEL = 10;

// dir : { X: 1 } ou { X: 1, Y: -1 }. settings : réglages $ de Grbl.
export function jogPlan(dir, { step, feed, settings = {} }) {
  const axes = AXES.filter((a) => Number(dir[a]));
  const norm = Math.hypot(...axes.map((a) => dir[a]));
  const unit = Object.fromEntries(axes.map((a) => [a, dir[a] / norm]));
  const setting = (base, a) => {
    const v = Number(settings[base + AXES.indexOf(a)]);
    return v > 0 ? v : null;
  };
  // Limites de Grbl le long du vecteur : celles de l'axe le plus contraignant.
  const maxRate = Math.min(...axes.map((a) => (setting(110, a) ?? Infinity) / Math.abs(unit[a])));
  const accel = Math.min(...axes.map((a) => (setting(120, a) ?? DEFAULT_ACCEL) / Math.abs(unit[a])));
  const stepLen = step * norm;
  const stepRate = Math.max(1, Math.round(Math.min(feed, maxRate)));
  const rate = Math.max(1, Math.round(Math.min(stepRate, (stepLen / JOG_REPEAT_MS) * 60000)));
  const v = rate / 60;
  const lead = (v * v) / (2 * accel) + v * MARGIN_S;
  // Arrondi au micron supérieur : la précision des commandes envoyées.
  const segment = Math.ceil(Math.max(lead / MAX_BLOCKS, v * MIN_SEGMENT_S, MIN_SEGMENT_MM) * 1000) / 1000;
  // Même vitesse que le pas de l'appui : le mouvement continu le prolonge.
  return { unit, stepLen, stepRate, rate, accel, lead, segment, continuesStep: rate >= stepRate };
}

// Distance parcourue après t secondes, départ arrêté, vitesse v, accélération a.
export function travelled(t, v, a) {
  if (t <= 0) return 0;
  return t < v / a ? 0.5 * a * t * t : v * t - (v * v) / (2 * a);
}

// Nombre de segments à envoyer maintenant pour garder l'avance voulue.
// elapsed : secondes depuis le départ arrêté ; sent : distance envoyée depuis ;
// inFlight : segments pas encore acquittés.
export function segmentsDue(plan, elapsed, sent, inFlight, maxInFlight = 2) {
  const target = travelled(elapsed, plan.rate / 60, plan.accel) + plan.lead;
  let n = 0;
  while (sent + n * plan.segment < target && inFlight + n < maxInFlight) n++;
  return n;
}

export const segmentAxes = (plan) =>
  Object.fromEntries(Object.entries(plan.unit).map(([a, u]) => [a, u * plan.segment]));
