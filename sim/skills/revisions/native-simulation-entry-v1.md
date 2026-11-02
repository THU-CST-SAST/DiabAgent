---
name: blood-glucose-management
description: Use for SweetBench synthetic-patient glucose-control decisions, interpreting uncertain CGM/IOB/COB, planning insulin or rescue carbohydrate actions, and choosing pump versus pen operations. Contains the benchmark's integrated B3 predictive HCL and B4 oref1/SMB/UAM knowledge, hourly-control limitations and exact backend-operation reference. Consult relevant sections when forming a non-urgent plan, checking an unfamiliar device operation or revising predictions that disagree with observations. This edition is for the supplied simulator MCP tools, not real-patient treatment or installing an AAPS runtime.
---

# Glucose Knowledge for the Synthetic Experiment

This is a simulator-focused entrypoint to the same glucose-management Skill. The existing book references, integrated closed-loop knowledge and backend-operation reference are retained. Use the material to improve reasoning about the current public observation, not to obtain hidden patient facts or automatically run a baseline controller.

## Use the Relevant Knowledge

Consulting a relevant reference before the first non-urgent plan is recommended. Revisit it when observed glucose repeatedly differs from a prediction, sensor and meter evidence conflict, insulin or carbohydrate timing is uncertain, activity or illness changes, or a device operation is unfamiliar. For an urgent safety action, act directly when needed. There is no requirement to look up a chapter before every action, and no retrieval reward, refusal or score penalty.

Choose the smallest relevant set of references; do not load the whole library:

- Pump basal control, insulin timing, B3 HCL and B4 oref1/SMB/UAM: [pump and closed-loop knowledge](references/07-pump-basal-bolus-and-closed-loop.md). The integrated benchmark algorithms are near the end under **Two closed-loop controllers in this benchmark**. Native Read uses line offsets and limits; read the relevant section rather than only the beginning of a long chapter.
- Temporary basal, suspension/resumption, extended delivery, cancellation, backend differences and the pen injection budget: [benchmark hardware operations](references/16-benchmark-hardware-operations.md). Check the current action table: a reference does not make an unavailable action legal.
- IOB, corrections, delayed response, hypoglycemia and rescue treatment: [insulin corrections and hypoglycemia](references/05-insulin-corrections-and-hypoglycemia.md).
- Slow digestion, meal timing and delayed carbohydrate effects: [food digestion](references/02-food-digestion-gi-gl.md) and [carbohydrate, fat and protein](references/03-carb-fat-protein-and-mealtime-insulin.md).
- Sensor uncertainty and patterns: [CGM and pattern analysis](references/04-cgm-agp-and-pattern-analysis.md).
- Exercise: [exercise management](references/06-exercise-management.md). Children, illness and other special situations: [special situations](references/08-children-travel-pregnancy-and-special-situations.md).
- Evidence interpretation or a source-safety question: [evidence and safety contract](references/11-safety-evidence-and-answer-contract.md). For a topic not listed here, use the [retrieval index](references/00-retrieval-index.md).

## Native Workflow and Boundaries

Use Claude Code's native Skill and Read to consult these fixed Markdown resources. Use only the supplied experiment MCP tools for glucose history, what-if simulation and action submission. The host controller alone executes simulated actions. No installation, shell command, separate chat model, AAPS service or external planner is needed or authorized in this environment. The archived standalone-runtime and real AAPS tool references describe other environments; they are not instructions to start those workflows here.

Keep the registered native-turn, reference-read, history and simulation budgets. Skill activation itself uses a native turn. Knowledge lookup does not advance virtual time or consume an extra observation slot. Leave room for act. When useful, retain a concise lesson in the existing notes; distinguish an observed response from a tentative explanation. Do not assume query scratch persists across decisions.

Use current public Profile values, device limits, sensor age, IOB/COB estimates, prior actions and actual receipts. Missing records are unknown, not zero, and a command receipt is not proof of tissue delivery. Do not fill patient parameters from book examples, infer hidden meals, inspect simulator truth, copy a baseline's unavailable action or assume a controller updates every five minutes between hourly decisions. Consider action duration, expiry and insulin already on board. Prioritize low-glucose protection and assess persistent high glucose or possible delivery failure rather than blindly stacking corrections.

Use the actual task's declared scoring band and public patient target. A consensus clinical range discussed in a reference, such as 70–180 mg/dL, is not automatically the benchmark's narrower scoring range. Do not substitute one for the other or trade low-glucose protection for a higher score. The reference supplies reasoning concepts; it does not redefine the registered scoring rule.

There is no reward for a complicated pump action. Choose a legal operation only when its effect fits the public evidence; pens remain subject to their registered physical-injection limit. This synthetic-action authorization does not authorize real-device treatment, real clinical prescriptions, configuration changes or use of credentials outside the experiment.

## Source Boundary

The original cited book notes and reference evidence levels remain in their existing files, together with the integrated benchmark B3/B4 addition and backend reference. This entrypoint changes discovery and routing for the synthetic task, not the underlying scientific world, treatment safety checks or scoring. Upstream source, original entry hash, parent edition and every unchanged reference hash are recorded in the edition manifest. Do not treat a simulator result as evidence of clinical efficacy.
