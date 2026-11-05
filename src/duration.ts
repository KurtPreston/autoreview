/** Format a run's length for the summary, such as "2m 5s". */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m ${seconds % 60}s`;
}
