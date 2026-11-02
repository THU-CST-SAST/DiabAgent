# Deichmann2023 reference implementation

Upstream: https://gitlab.com/csb.ethz/t1d-exercise-model

Pinned commit: `6bc0a4f6b728a274a51d271a79cb59c24848b19a`.

Paper: https://doi.org/10.1371/journal.pcbi.1010289 (15 February 2023).

The Python functions, Figure 4 driver, parameter CSVs and LICENSE in this
directory are unmodified copies from that commit. Tests verify SHA-256 hashes.
The upstream patient datasets are not redistributed. Code is BSD-3-Clause.
The TypeScript translation in `model/Deichmann2023.ts` retains these
authors' copyright and is subject to the accompanying BSD notice.

`test/fixtures/deichmann2023-reference.json` records upstream source hashes,
parameters, 48 derivative cases, 20 Figure 4 trajectories and a measured-plasma
case generated with the original Python functions using SciPy LSODA.
`test/kernel.test.js` compares the translation to those reference outputs.
The live service does not run the author's bolus calculator. Gut meal pools
and continuously delivered pump inputs are supplied by the service adapter;
the reference test uses the upstream sampled-input convention instead.
