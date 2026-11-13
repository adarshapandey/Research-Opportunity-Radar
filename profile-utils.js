export const profileFields = ['research_areas', 'current_projects', 'keywords'];

export function validateProfileChanges(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid research profile.');
  const changes = {};
  for (const key of profileFields) {
    if (!Array.isArray(value[key]) || value[key].length > 50 || value[key].some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) {
      throw new Error('Use up to 50 entries per section, with 1–200 characters per entry.');
    }
    changes[key] = [...new Set(value[key].map(v => v.trim()))];
  }
  if (!changes.research_areas.length) throw new Error('Add at least one research area.');
  return changes;
}

export function matchStoredOpportunity(opportunity, profile) {
  const text = [opportunity.title,opportunity.organization,...(opportunity.topics || []),opportunity.source?.evidence].join(' ').toLowerCase();
  const matched = [...new Set(profileFields.flatMap(key => profile[key] || []))].filter(term => term.length >= 3 && text.includes(term.toLowerCase()));
  return {...opportunity,matches_profile:matched.length > 0,relevance:{
    level:matched.length ? 'medium' : 'potential', label:matched.length ? 'Good match' : 'Potential match',
    matched_topics:matched,
    reason:matched.length ? `Listed information overlaps with your research interests: ${matched.join(', ')}.` : 'No direct topic matches to your current research profile. This previously saved opportunity remains available in search and your watchlist.'
  }};
}
