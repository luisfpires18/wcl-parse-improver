// Does this pasted log actually contain the character you're analysing?
//
// Every number in the report is built by comparing YOUR run against a ranked
// parse of YOUR class and spec. Feed it a log where "Unreally" is a Demon Hunter
// while the active character is an Unholy Death Knight, and nothing errors — the
// actor resolves by name, the casts parse fine, and out comes a comparison of
// Havoc's rotation against a Death Knight benchmark. Every section is wrong, and
// nothing says so.
//
// The M+ path can't hit this: it finds runs through the character's own rankings,
// so the class and spec are right by construction. Only the pasted-log path can,
// which is exactly where a person is most likely to paste the wrong thing.
//
// masterData.actors carries the CLASS (subType) but never the spec, so the check
// reads playerDetails out of the Summary table, which has both.
import { gql, dumpDebug } from './client.js';
import { REPORT_SUMMARY } from './queries.js';

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** Every player in the fight, with class and spec. */
export async function fetchReportPlayers({ code, fightID, refresh = false }) {
  const data = await gql(REPORT_SUMMARY, { code, fightIDs: [fightID] }, { noCache: refresh });
  const details = data?.reportData?.report?.table?.data?.playerDetails;
  if (!details) {
    dumpDebug('report-summary-no-playerDetails', { code, fightID });
    return [];
  }
  // playerDetails is grouped by role (dps / healers / tanks)
  return Object.values(details)
    .flat()
    .filter((p) => p?.name)
    .map((p) => ({
      name: p.name,
      className: p.type ?? null, // WCL class slug, e.g. "DeathKnight"
      specs: Array.isArray(p.specs) ? p.specs : [],
      server: p.server ?? null,
    }));
}

/** Fetch the roster, then apply the rules. Throws with a human message on mismatch. */
export async function assertCharacterInLog({ code, fightID, name, className, specName, classLabel, refresh = false }) {
  const players = await fetchReportPlayers({ code, fightID, refresh });
  return matchCharacter(players, { name, className, specName, classLabel });
}

/**
 * The decision, with no I/O: is this character in this roster AS the class and
 * spec being analysed? Returns the matched player, or throws a message the user
 * can act on.
 *
 * Spec is checked only when the log actually reports one — a log can carry a
 * player with no spec recorded, and refusing to analyse it over missing metadata
 * would be worse than the thing we're guarding against.
 */
export function matchCharacter(players, { name, className, specName, classLabel }) {
  if (!players?.length) return null; // couldn't read the roster; don't block on it

  const sameName = players.filter((p) => norm(p.name) === norm(name));
  if (!sameName.length) {
    const who = players
      .slice(0, 8)
      .map((p) => p.name)
      .join(', ');
    throw badRequest(
      `${name} isn't in that log. It contains: ${who}${players.length > 8 ? `, +${players.length - 8} more` : ''}. ` +
        `Paste a report that ${name} actually played in.`
    );
  }

  // right name, right class?
  const sameClass = sameName.filter((p) => !className || norm(p.className) === norm(className));
  if (!sameClass.length) {
    const found = sameName.map((p) => describe(p)).join(' / ');
    throw badRequest(
      `That log is the wrong character. It has ${name} as ${found}, but you're analysing ` +
        `${name} — ${classLabel ?? className}${specName ? ` (${specName})` : ''}. ` +
        `Every number here compares you against a ranked ${specName ?? className} parse, so a different class would be meaningless. ` +
        `Switch character, or paste a log where your ${classLabel ?? className} played.`
    );
  }

  // right class, right spec? (only when the log recorded one)
  if (specName) {
    const withSpecs = sameClass.filter((p) => p.specs.length);
    if (withSpecs.length) {
      const match = withSpecs.find((p) => p.specs.some((s) => norm(s) === norm(specName)));
      if (!match) {
        const played = [...new Set(withSpecs.flatMap((p) => p.specs))].join(', ');
        throw badRequest(
          `Right character, wrong spec. In that log ${name} played ${played}, but you're analysing ${specName}. ` +
            `The comparison is against a ranked ${specName} parse, so a different spec would be meaningless. ` +
            `Switch the spec above, or paste a log where you played ${specName}.`
        );
      }
      return match;
    }
  }

  return sameClass[0];
}

const describe = (p) => `${p.className ?? 'unknown class'}${p.specs.length ? ` (${p.specs.join('/')})` : ''}`;

/**
 * These are USER mistakes (wrong log, wrong character selected), not server
 * faults, so they must not surface as a 500. Tagged with a status the routes
 * honour.
 */
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}
