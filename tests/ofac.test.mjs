import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const src = readFileSync(new URL('../js/ofac.js', import.meta.url), 'utf8');
const Ofac = runInNewContext(src + '\nOfac;', {});

const aircraft = [
  { reg: '9H-AOJ', name: 'Test Airbus', reason: 'designated' },
  { reg: '9V-OJC', name: 'Test Gulfstream', reason: 'designated' },
];
const vessels = [
  { imo: '8713708', name: 'ATLANTIC RUNNER', reason: 'navy service' },
  { imo: '', name: 'VIRGINIA G', reason: 'designated' },
];

test('matchAircraft matches registration (case/punct-insensitive) and labelled callsign', () => {
  assert.equal(Ofac.matchAircraft(aircraft, '9h-aoj', '').kind, 'registration');
  assert.equal(Ofac.matchAircraft(aircraft, '9HAOJ', '').kind, 'registration');
  assert.equal(Ofac.matchAircraft(aircraft, '', '9V-OJC').kind, 'registration');
  assert.equal(Ofac.matchAircraft(aircraft, '', 'TEST25'), null);
  assert.equal(Ofac.matchAircraft(aircraft, 'N482UA', 'N482UA'), null);
  assert.equal(Ofac.matchAircraft([], '9H-AOJ', ''), null);
  assert.equal(Ofac.matchAircraft(null, '9H-AOJ', ''), null);
});

test('matchVessel prefers IMO over name', () => {
  assert.equal(Ofac.matchVessel(vessels, '8713708', 'ANY NAME').kind, 'imo');
  assert.equal(Ofac.matchVessel(vessels, '', 'virginia g').kind, 'name');
  assert.equal(Ofac.matchVessel(vessels, '', 'Virginia G').kind, 'name');
  assert.equal(Ofac.matchVessel(vessels, '1111111', 'SOME OTHER SHIP'), null);
  assert.equal(Ofac.matchVessel([], '8713708', 'ATLANTIC RUNNER'), null);
});

test('flagText states the matched field and the name-match caution', () => {
  assert.match(Ofac.flagText({ kind: 'imo', reason: 'navy service' }), /IMO match/);
  assert.match(Ofac.flagText({ kind: 'name', reason: 'x' }), /name match/);
  assert.match(Ofac.flagText({ kind: 'name', reason: 'x' }), /verify IMO/);
  assert.match(Ofac.flagText({ kind: 'registration', reason: '' }), /registration match/);
  assert.equal(Ofac.flagText(null), '');
});

test('norm strips separators and upper-cases', () => {
  assert.equal(Ofac.norm(' 9h-aoj '), '9HAOJ');
  assert.equal(Ofac.norm(null), '');
});
