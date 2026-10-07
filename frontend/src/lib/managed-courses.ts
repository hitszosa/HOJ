/** Offering IDs and management course IDs are separate; only use authorized links. */
export function managedCoursePath(offeringId: string, links: unknown): string | null {
  if (!/^[1-9]\d*$/.test(offeringId) || !Number.isSafeInteger(Number(offeringId)) || !Array.isArray(links)) return null;
  const matches = links.filter(link => link && link.offering_id === Number(offeringId)
    && Number.isSafeInteger(link.course_id) && link.course_id > 0);
  const courses = new Set(matches.map(link => link.course_id));
  return courses.size === 1 ? `/management/courses/${matches[0].course_id}` : null;
}
