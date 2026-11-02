# Two closed-loop controllers in this benchmark

This is research knowledge for synthetic Sweet-sim patients, not a clinical prescription, a patient Profile, or permission to operate real hardware. Keep the original Skill evidence/safety contract. These are descriptions of the repository's simplified B3/B4 policies, not exact reproductions of commercial firmware or a complete AndroidAPS installation. Patient-specific inputs must come from the current public observation and action specifications. Missing information is unknown, not zero; do not consult hidden physiology, future events, true delivery or unreported food.

## Read the state before choosing an action

Check units, sensor age, CGM quality, recent trend, public insulin delivery ledger and IOB, reported food and COB, device status, available actions, activity/sleep/illness reports, and prior action receipts. Sensor glucose is perturbed and delayed; it is not physiological truth. Use only supplied tools. A pump plus fresh real-time CGM is required for closed-loop basal control; pens, sensor warm-up, gaps or stale readings require the available open-loop/fallback tools instead. Do not infer that a delivered command means insulin actually reached tissue.

## B3: simplified predictive hybrid closed loop

The local `src/policies/hcl.mjs` combines a guideline user layer with a Control-IQ-inspired predictive loop. It projects glucose 30 minutes ahead using a bounded recent sensor trend, then considers reducing/suspending basal for predicted lows, leaving the scheduled basal near target, and increasing basal for predicted highs. The implementation's normal thresholds are 70 / 112.5 / 160 mg/dL. Its high prediction correction uses `(predicted_glucose - target) / ISF - public_IOB`, with negative excess set to zero and device/policy limits enforced. These implementation constants are not patient treatment targets.

The local automatic bolus branch requires prediction above 180 mg/dL, no sleep/exercise activity, no pending person meal dose, and a legal device interval. It uses at most 60% of the IOB-aware excess, at most once per hour and within its 6 U policy ceiling and the actual device limits. Scheduled basal increases are capped at 3 times the schedule and the pump maximum. The controller avoids repeatedly changing a similar active temporary basal. It retains reported-meal dosing, low treatment and device hygiene through the user layer. Sleep/exercise windows and prediction are simplified here; actual product versions can behave differently.

## B4: oref1 / SMB / UAM-inspired open-source loop

The local `src/policies/oref1.mjs` calls the vendored OpenAPS `determine-basal` core and adds a guideline user layer. It supplies recent sensor deltas, the public insulin ledger and its modeled future activity, public COB/reported carbs, current temporary basal and Profile. It considers insulin-on-board, carb-on-board and unannounced-meal prediction paths before proposing a bounded basal adjustment or a super micro bolus (SMB). UAM means investigating glucose deviations not explained by known insulin/food; it does not reveal hidden meals or grant extra observations.

The local autosens approximation collects observed deviations over up to 8 hours, excludes 4 hours after reported carbs, requires at least 4 hours of eligible data and bounds its ratio to 0.7–1.2. Insufficient eligible history means no inferred adjustment, not a fabricated sensitivity estimate. This is not the full AAPS sensitivity detection pipeline. Its exercise branch uses an elevated temporary target and inhibits high-target SMB. SMB is disabled when a person's meal bolus is pending or on the assisted track to avoid double dosing under the simulator's bolus interval. `carbsReq`, low protection and IOB limits constrain aggressive dosing. The implementation's max-IOB and absorption approximations are research settings, not instructions to configure a real device.

## Applying the concepts at hourly decision boundaries

These algorithms were designed for frequent feedback. An hourly caller cannot assume the loop is silently recomputed every 5 minutes. The simulator continues its existing delivery and lets temporary basals expire; it does not rerun either algorithm between consultations. Do not multiply an SMB by 12, stretch a temporary basal, bypass a device limit or stack a correction merely because the next fixed observation is an hour away. Consider the duration, current IOB, likely response delay and risk of the chosen action over that gap. When useful, use the supplied simulate/history tools and permitted earlier follow-up or alarm subscriptions, within the same original daily extra budget. A predicted low takes priority over pursuing a high-glucose correction. Persistent hyperglycemia with possible infusion failure or illness needs device/safety assessment rather than blind repeated dosing. Use action receipts to distinguish rejected, pending and applied actions.

The benchmark host alone executes actions. This text does not add a callable controller, automatically select either baseline's action, change the world, unlock hidden I2 data, or relax the original real-device confirmation contract.

## Sources and version boundary

- Exact experimental behavior: repository `src/policies/hcl.mjs`, `src/policies/oref1.mjs`, `src/policies/care.mjs`, and vendored `vendor/oref0/lib/determine-basal/determine-basal.js`; retain their source hashes in each experiment.
- Product background, not an assertion that the local approximation equals the product: [Tandem Control-IQ treatment values](https://www.tandemdiabetes.com/support-center/pumps-and-supplies/automated-insulin-delivery/article/control-iq-treatment-values?set-locale=true).
- Algorithm concepts and cautions: [AAPS OpenAPS features](https://androidapsdocs.readthedocs.io/en/latest/Usage/Open-APS-features.html), [AAPS sensitivity detection and COB](https://wiki.aaps.app/en/dev/DailyLifeWithAaps/SensitivityDetectionAndCob.html).
- This section is an integrated research addition to this Skill, not a separate runtime extension. It supplies no extra patient facts and makes no clinical efficacy or safety guarantee.
