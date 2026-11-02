# Safety and Security

Synthetic research only. Do not connect this benchmark or its Skill to real insulin-delivery hardware or use generated doses as treatment advice.

Never commit credentials, native HOME/auth files, private patient reconstructions, or unreviewed experiment logs. Use your own short-lived environment credentials. Review all raw outputs before publication. Report potential credential exposure privately to the repository maintainers rather than posting the credential in an issue.

The benchmark controller separates evaluator-private fixtures from agent-visible observations. Native coding tools are restricted to the registered simulation/knowledge tool surface, but running a model still executes installed third-party CLI software: use an isolated research environment and trusted binaries. Do not expose the optional simulator HTTP service to an untrusted network.
