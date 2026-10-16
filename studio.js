'use strict';
// The Studio: a designer agent turns trend research into print designs, an image model draws them,
// and a separate judge agent decides which are good enough to sell.
const config = require('./config');
const store = require('./store');
const { callForTool } = require('./claude');
const { generateImage, saveImage } = require('./images');
const { readNote } = require('./tools');

const DESIGNER_SYSTEM = `You are the designer for a print-on-demand wall art shop on Etsy, run by Craig in the UK. You turn trend research into print designs that an image model will draw.

Rules:
- Every design must be original. Never reference or imitate brands, logos, trademarks, characters from film, TV, games, books or cartoons, celebrities or real people, sports teams, or a named artist's signature style. General art styles (art nouveau, mid-century modern, botanical illustration, Bauhaus, risograph, linocut) are fine.
- Avoid text in the image unless the theme needs it. If you include text, use at most 4 short, common words, give the exact words in quotes, and say they must be spelled exactly.
- Designs are printed as posters in a ${config.imageAspect} portrait ratio (12x16 or 18x24 inches). Ask for full-bleed flat artwork whose background runs right to every edge of the canvas: no white or cream margin, no paper edge, no frame, border, mockup, wall, signature or watermark. Keep the main subject and any text comfortably inside the edges (prints are trimmed slightly), but the background colour or pattern must still reach the edges.
- Make each design clearly different from the others and from recent designs, commercially appealing, and true to the trend.
- Write prompts as rich, specific descriptions: subject, composition, colour palette (name the colours), medium or technique, mood and level of detail.`;

const JUDGE_SYSTEM = `You are the quality judge for an Etsy wall art shop. You did not make these designs. Decide whether each one is good enough to list for sale as a printed poster.

Be strict. A buyer pays £20 to £40 and hangs this on their wall, and most first attempts from image models have flaws. You get the whole design (downsized) and a full-resolution crop from the centre, which shows detail at real print size.

Check:
1. Print quality: artefacts, smudges, warped or melted shapes, wrong anatomy, muddy areas, blurry or mushy detail in the crop, and any unwanted frames, borders, white or cream margins, paper edges, mockups, watermarks or signatures. The artwork should be full-bleed, with its background reaching every edge.
2. Text: any text must be perfectly spelled and cleanly drawn. Garbled or made-up lettering is an automatic fail.
3. IP risk: anything resembling a logo, brand, trademarked character, celebrity, or a specific artist's signature work.
4. Sellability: would this sell on Etsy for its theme? Consider appeal, composition, colour harmony and how well it matches the brief.
5. Originality: does it feel fresh rather than generic stock art?

Score 1 to 10, where 7 means good enough to sell and 9 or above is rare.
Verdict: "pass" only if it can be sold exactly as it is; "revise" if a better prompt could fix it; "reject" if the concept is weak or risky. For "revise", give specific changes to make to the prompt.`;

const BRIEFS_TOOL = {
  name: 'submit_briefs',
  description: 'Submit the design briefs.',
  input_schema: {
    type: 'object',
    properties: {
      briefs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short product name, e.g. "Moody Plum Rose Botanical Print"' },
            theme: { type: 'string', description: 'Which trend this comes from' },
            prompt: { type: 'string', description: 'The full image prompt' },
            why: { type: 'string', description: 'One sentence on why it will sell' },
          },
          required: ['title', 'theme', 'prompt', 'why'],
        },
      },
    },
    required: ['briefs'],
  },
};

const VERDICT_TOOL = {
  name: 'submit_verdict',
  description: 'Submit your verdict on the design.',
  input_schema: {
    type: 'object',
    properties: {
      print_quality: { type: 'integer', minimum: 1, maximum: 10 },
      sellability: { type: 'integer', minimum: 1, maximum: 10 },
      originality: { type: 'integer', minimum: 1, maximum: 10 },
      ip_risk: { type: 'string', enum: ['none', 'possible', 'clear'] },
      text_problems: { type: 'boolean', description: 'True if any text is misspelled, garbled or badly drawn' },
      defects: { type: 'array', items: { type: 'string' }, description: 'Specific problems you can see' },
      verdict: { type: 'string', enum: ['pass', 'revise', 'reject'] },
      feedback: { type: 'string', description: 'Short summary, plus prompt changes if revising' },
    },
    required: ['print_quality', 'sellability', 'originality', 'ip_risk', 'text_problems', 'defects', 'verdict', 'feedback'],
  },
};

const PROMPT_TOOL = {
  name: 'submit_prompt',
  description: 'Submit the revised image prompt.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
      change_summary: { type: 'string', description: 'One sentence on what you changed' },
    },
    required: ['prompt', 'change_summary'],
  },
};

// The judge's opinion plus hard rules decide whether a design passes.
function decide(v) {
  const scoresOk =
    Math.min(v.print_quality, v.sellability) >= config.judgeMinScore && v.originality >= config.judgeMinOriginality;
  if (v.ip_risk === 'clear') return { outcome: 'reject', reason: 'Looks too close to someone else’s brand or character.' };
  if (v.verdict === 'reject') return { outcome: 'reject', reason: v.feedback };
  if (v.verdict === 'pass' && v.ip_risk === 'none' && !v.text_problems && scoresOk) return { outcome: 'pass' };
  return { outcome: 'revise' };
}

const money = (n) => '$' + n.toFixed(2);

async function runDesignJob(job, ctl, { addStep, checkLimits }) {
  const budget = config.designBudget;
  const count = Math.max(1, Math.min(config.maxDesignsPerRun, Number(job.params?.count) || 3));
  const theme = String(job.params?.theme || '').trim();
  const trends = readNote('trends');
  if (!theme && !trends) throw new Error('No theme given and no "trends" note yet. Run a trends task first, or type a theme.');

  checkLimits(job, ctl, budget);

  // 1. Designer writes briefs.
  const recent = store
    .listDesigns()
    .slice(0, 30)
    .map((d) => `- ${d.title}`)
    .join('\n');
  const ask = [
    theme ? `Theme to design for: ${theme}` : `Trend research (from the "trends" note):\n${trends}`,
    recent ? `Recent designs, so avoid repeating these:\n${recent}` : '',
    `Write exactly ${count} design brief${count > 1 ? 's' : ''}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const { briefs = [] } = await callForTool(job, {
    system: DESIGNER_SYSTEM,
    messages: [{ role: 'user', content: ask }],
    tool: BRIEFS_TOOL,
    signal: ctl.abort.signal,
  });
  const plan = briefs.slice(0, count);
  if (!plan.length) throw new Error('The designer returned no briefs.');
  addStep(job, { kind: 'thought', label: 'Designer', detail: plan.map((b, i) => `${i + 1}. ${b.title}: ${b.why}`).join('\n') });

  const made = [];
  for (const brief of plan) {
    checkLimits(job, ctl, budget);
    const design = store.createDesign({
      jobId: job.id,
      title: brief.title,
      theme: brief.theme,
      why: brief.why,
      model: config.imageModel,
      size: config.imageSize,
    });
    made.push(design);
    let prompt = brief.prompt;

    try {
      for (let attempt = 0; attempt <= config.maxRevisions; attempt++) {
        checkLimits(job, ctl, budget);
        design.status = 'generating';
        store.saveDesigns();
        addStep(job, { kind: 'tool', label: attempt ? 'Redraw' : 'Draw', detail: brief.title });

        // 2. Image model draws it.
        let img;
        try {
          img = await generateImage(prompt, ctl.abort.signal);
        } catch (err) {
          if (!err.noImage) throw err; // handled below: skip this design or stop the run
          design.attempts.push({ prompt, error: err.message, at: new Date().toISOString() });
          addStep(job, { kind: 'error', label: 'Image refused', detail: err.message });
          if (attempt === config.maxRevisions) break;
          prompt = await revise(job, ctl, brief, prompt, `The image model refused or returned nothing: ${err.message}. Rewrite the prompt so it is clearly safe and original.`);
          continue;
        }
        job.imageUsd = (job.imageUsd || 0) + img.costUsd;
        job.costUsd += img.costUsd;
        design.costUsd += img.costUsd;
        const n = design.attempts.length;
        const saved = await saveImage(design.id, n, img.buffer);

        // 3. Judge looks at it.
        design.status = 'judging';
        store.saveDesigns();
        const before = job.costUsd;
        const verdict = await callForTool(job, {
          system: JUDGE_SYSTEM,
          tool: VERDICT_TOOL,
          signal: ctl.abort.signal,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `Design: "${brief.title}"\nTheme: ${brief.theme}\nIntended appeal: ${brief.why}\n\nFull design:` },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: saved.preview.toString('base64') } },
                { type: 'text', text: 'Centre crop at full print resolution:' },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: saved.crop.toString('base64') } },
              ],
            },
          ],
        });
        design.costUsd += job.costUsd - before;
        const { outcome, reason } = decide(verdict);
        design.attempts.push({
          prompt,
          width: saved.width,
          height: saved.height,
          verdict,
          outcome,
          at: new Date().toISOString(),
        });
        const scores = `quality ${verdict.print_quality}, sells ${verdict.sellability}, original ${verdict.originality}`;
        addStep(job, {
          kind: outcome === 'pass' ? 'result' : 'error',
          label: `Judge: ${outcome}`,
          detail: `${brief.title} (${scores})\n${verdict.feedback}`,
        });

        if (outcome === 'pass') {
          design.status = 'passed';
          break;
        }
        if (outcome === 'reject') {
          design.status = 'rejected';
          design.reason = reason;
          break;
        }
        if (attempt === config.maxRevisions) break;

        // 4. Designer revises using the judge's notes.
        design.status = 'revising';
        store.saveDesigns();
        const notes = [verdict.feedback, ...verdict.defects.map((d) => `- ${d}`)].join('\n');
        prompt = await revise(job, ctl, brief, prompt, `The judge's notes:\n${notes}`);
      }
      if (!['passed', 'rejected'].includes(design.status)) {
        design.status = 'rejected';
        design.reason = `Didn't pass after ${config.maxRevisions + 1} attempt${config.maxRevisions ? 's' : ''}.`;
      }
    } catch (err) {
      design.status = 'rejected';
      design.reason = ctl.stopped ? 'Stopped by you.' : err.message;
      store.saveDesigns();
      // A dropped connection or busy server (after retries) only loses this design;
      // setup problems, budget limits and the stop button end the whole run.
      const skippable = !ctl.stopped && (err.network || err.fatal === false);
      if (!skippable) throw err;
      addStep(job, { kind: 'error', label: 'Skipped', detail: `${brief.title}: ${err.message}` });
    }
    store.saveDesigns();
  }

  const passed = made.filter((d) => d.status === 'passed');
  job.result = [
    `**${passed.length} of ${made.length} design${made.length > 1 ? 's' : ''} passed the judge.**`,
    '',
    ...made.map((d) => `- ${d.status === 'passed' ? '✅' : '❌'} **${d.title}** (${money(d.costUsd)})${d.reason ? ': ' + d.reason : ''}`),
    '',
    `Claude ${money(job.claudeUsd || 0)} · images ${money(job.imageUsd || 0)}. See them in the Studio tab.`,
  ].join('\n');
  job.status = 'done';
}

async function revise(job, ctl, brief, prompt, problem) {
  const out = await callForTool(job, {
    system: DESIGNER_SYSTEM,
    tool: PROMPT_TOOL,
    signal: ctl.abort.signal,
    messages: [
      {
        role: 'user',
        content: `Design: "${brief.title}" (${brief.theme})\n\nPrevious prompt:\n${prompt}\n\n${problem}\n\nWrite an improved prompt that fixes these problems while keeping the concept.`,
      },
    ],
  });
  return out.prompt;
}

module.exports = { runDesignJob, decide };
