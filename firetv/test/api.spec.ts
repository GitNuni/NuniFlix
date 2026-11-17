import {isPrivateHost, normalizeServer} from '../src/api';

describe('server address rules', () => {
  it('allows plain http only inside the home network', () => {
    expect(isPrivateHost('192.168.0.49')).toBe(true);
    expect(isPrivateHost('10.0.0.2')).toBe(true);
    expect(isPrivateHost('172.20.1.1')).toBe(true);
    expect(isPrivateHost('100.101.102.103')).toBe(true);
    expect(isPrivateHost('tower.local')).toBe(true);
    expect(isPrivateHost('8.8.8.8')).toBe(false);
    expect(isPrivateHost('requests.example.com')).toBe(false);
  });

  it('fills in http:// and trims slashes', () => {
    expect(normalizeServer('192.168.0.49:8095/')).toBe('http://192.168.0.49:8095');
    expect(normalizeServer('https://requests.example.com')).toBe('https://requests.example.com');
  });

  it('refuses http to an internet address', () => {
    expect(() => normalizeServer('http://requests.example.com')).toThrow(/https/);
    expect(() => normalizeServer('not an address')).toThrow();
  });
});

describe('address tidy-up', () => {
  it('lowercases the scheme and host (TV keyboards capitalise)', () => {
    expect(normalizeServer('HttpS://Flix.Example.com')).toBe('https://flix.example.com');
  });
});
