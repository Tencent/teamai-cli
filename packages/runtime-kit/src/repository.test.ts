import { describe, expect, it } from 'vitest';
import { repositoryKey } from './repository.js';

describe('the repository a remote names', () => {
  it.each([
    ['https://github.com/acme/acme-app.git', 'github.com/acme/acme-app'],
    ['git@github.com:Acme/Acme-App.git', 'github.com/acme/acme-app'],
    ['ssh://git@gitlab.example.com:2222/team/sub/app.git', 'gitlab.example.com/team/sub/app'],
    ['https://github.com/acme/acme-app/', 'github.com/acme/acme-app'],
    ['not a url', undefined],
  ])('%s is %s', (url, key) => {
    expect(repositoryKey(url)).toBe(key);
  });
});
