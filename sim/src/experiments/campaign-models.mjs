/** Keep the established GPT/GLM pair; optionally add one native Anthropic arm. */
export function validateCampaignModels(models) {
  if(!Array.isArray(models)||![2,3].includes(models.length)
    ||models.slice(0,2).some(m=>m.adapter!=='openai-compatible'||m.wire_api!=='responses')
    ||(models.length===3&&(models[2].adapter!=='anthropic'||!models[2].model?.startsWith('claude-'))))
    throw Error('Expected two Responses configs, optionally followed by one native Anthropic config');
}
