// Asks GitHub how many stars a repository has, through atmos.fetch():
// Atmos makes the request (only to hosts in "permissions.network").
import atmos from 'atmos-sdk';

export const REPO = 'samsaraserenade/atmos-desktop';

export async function loadStars(signal) {
  const response = await atmos.fetch(`https://api.github.com/repos/${REPO}`, {
    headers: { accept: 'application/vnd.github+json' },
    signal,
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const { stargazers_count: stars } = await response.json();
  if (!Number.isInteger(stars)) throw new Error('GitHub sent no star count');
  return stars;
}
