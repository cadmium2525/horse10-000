import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { DIFFICULTY_SEEDS, HUMAN_250, HUMAN_250_MASH, IDLE_MASH, OPTIMAL, median, report, runRace } from './helpers/race';
const M: Record<string, any> = { H250: HUMAN_250, MASH: HUMAN_250_MASH, PASS: null, PASSMASH: IDLE_MASH, NOJUMP: { ...OPTIMAL, jump: false }, HOLD: { ...HUMAN_250, dash: 'hold' }, OPT: OPTIMAL };
it('H250', () => {
  const runs = DIFFICULTY_SEEDS.map((s) => runRace(s, M['H250']));
  report('H250', runs);
  writeFileSync('/tmp/claude-0/-home-user-horse10-000/518f29de-094f-561b-a3ec-3eff90cce778/scratchpad/out/H250.txt', JSON.stringify({ ranks: runs.map(r=>r.rank), gaps: runs.map(r=>+r.gap.toFixed(1)), jumps: runs.map(r=>r.jumps+'/'+r.jumpsCleared), falls: runs.map(r=>r.falls), perfect: runs.filter(r=>r.perfect).length, med: median(runs.map(r=>r.rank)), medgap: median(runs.map(r=>r.gap)) }));
}, 900000);
