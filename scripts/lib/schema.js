import { termRegex } from './normalize.js';

// Rule model, two strictness tiers: fields below use closed enums and are
// searchable; anything nuanced goes in freeform `params` objects (display-only).
// Bump SCHEMA_VERSION only with a migration note; annotations carry the version
// they were written against.
export const SCHEMA_VERSION = 12;

export const PROVENANCE = ['machine', 'template', 'claude', 'human'];

export const TRIGGER_TYPES = [
  'passive',                        // always-on statement ("This creature's attacks deal 30% more damage");
                                    //   "While X..." auras = passive + condition
  'activated',                      // effect of casting/using the thing itself (spells, consumables)
  'start_of_battle',
  'after_start_of_battle_effects',
  'end_of_battle',
  'start_of_turn',
  'end_of_turn',
  'after_attack',                   // subject performs an attack
  'after_attacked',                 // subject is attacked
  'after_deals_damage',
  'after_damaged',
  'after_kill',
  'after_death',
  'after_resurrected',
  'after_cast',                     // subject casts (params.manual for "manually casts")
  'after_targeted_by_cast',
  'after_afflicted',                // subject gains a debuff
  'after_gains_buff',
  'after_status_removed',
  'after_heal',                     // subject performs healing
  'after_healed',                   // subject receives healing
  'after_stat_change',              // params.direction: up|down
  'after_defend',
  'after_provoke',
  'after_dodge',
  'after_critical',
  'after_joins_battle',             // summoned/spawns mid-battle
  'after_effect_activates',         // another effect fired: on-attack effects, Trick
                                    //   Slots, innate traits (params.what names the family)
  'after_minion_gained',
  'after_minion_lost',              // minions go away, are sacrificed, or would depart
  'after_timeline_move',            // subject is moved on the Timeline (params.to:
                                    //   top|bottom, params.forced). The mirror of the
                                    //   timeline_move verb — without it you can search
                                    //   what MOVES the Timeline but not what fires off it.
  'after_status_effect',            // a status's OWN payload resolves: Bomb detonates,
                                    //   Burning ticks damage/healing, a creature breaks
                                    //   free from Snared. params.status names it.
                                    //   Plain "took damage" stays after_damaged.
  'non_combat',                     // breeding, loot, resources, overworld (mostly perks/realm)
  'other',
];

// One scope enum shared by trigger.subject, condition.who, action.actor, action.target.
export const SCOPES = [
  'holder',          // the entity this record's effect is attached to: trait holder,
                     //   relic bearer, the minion itself. NEVER the turn-taker
                     //   (that's trigger_subject). Not valid in spell rules (use caster).
  'relic',           // the relic itself — a battle entity distinct from its bearer
                     //   ("this relic Attacks"). Valid only in relic records.
  'ally',            // one of your other creatures
  'allies',          // "your creatures" as a group
  'random_ally',
  'enemy',           // a specific enemy (the one involved)
  'enemies',
  'random_enemy',
  'any',             // any creature
  'random_any',
  'target',          // the chosen target of a spell/action
  'trigger_subject', // whoever the trigger was about
  'attacker',
  'caster',
  'owner',           // a minion's master
  'minions',
  'adjacent_allies', // positional: allies adjacent to the holder (params for other anchors)
  'adjacent_enemies',
  'adjacent_any',
  'other',
];

export const CONDITION_TYPES = [
  'has_status',
  'lacks_status',
  'health_threshold',
  'stat_comparison',
  'team_composition',   // all/exact-count of a race or class in your party
  'class_is',
  'race_is',
  'count_comparison',   // generic "for each / if there are N ..."
  'damage_threshold',   // "if this damage exceeds X% of ..." execute-style checks
  'once_per_battle',
  'resource_threshold', // charges, mana
  'equipment',          // artifact / spell gem prerequisites
  'timeline_position',
  'action_state',       // in-battle state: "while they're Provoking/Defending/dead" —
                        //   params.state names it
  'comparison',         // dynamic property check: "target's class equals the caster's",
                        //   "first creature in the party" (params.what / equals)
  'outcome',            // rider on a prior action's result: "if this spell kills the
                        //   target", "if a debuff was removed" (params.result)
  'other',
];

export const ACTION_VERBS = [
  'apply_status',    // buff/debuff split derives from the status lexicon
  'remove_status',
  'steal_status',
  'prevent_status',  // immunity
  'status_modifier', // changes a status's potency/duration/behavior ("Rebirth lasts forever")
  'detonate',        // triggers a status's payload early (Bomb)
  'deal_damage',
  'damage_modifier', // deals/takes more/less damage (persistent or scoped)
  'attack',
  'extra_turn',
  'cast',
  'spell_modifier',  // gem/charge/cast rules ("spells don't consume charges")
  'heal',
  'healing_modifier',
  'resurrect',
  'kill',
  'stat_change',
  'stat_rule',       // "can't lose stats", "stats can't be reduced"
  'gain_charges',
  'charge_modifier',
  'summon_minion',
  'minion_modifier',
  'timeline_move',
  'battle_action',   // the creature performs a battle action itself:
                     //   params.action 'defend' | 'provoke'
  'redirect_target', // genuine targeting redirection (interception, Confused,
                     //   "target chosen at random") — NOT the Provoke action
  'spawn_modifier',  // overworld spawn/encounter rates (params.what names it)
  'prevent_action',  // "cannot Provoke/dodge/be resurrected/cast..."
  'dodge_modifier',  // dodge/avoid-damage chance changes
  'crit_chance_modifier', // critical-hit CHANCE changes; crit damage AMOUNT stays
                          //   damage_modifier + params.criticalOnly
  'equipment_modifier', // amplifies gear the creature carries: artifact
                        //   properties, Nether Stones (params.equipment names it)
  'copy',
  'transform',
  'grant_ability',   // grants traits/spell gems/abilities
  'trait_modifier',  // changes how traits themselves behave: potency, growth
                     //   rate, downsides (params.property). Granting a trait is
                     //   grant_ability; extra activations are activation_modifier.
  'resource_gain',   // non-combat loot/resources
  'activation_modifier', // effects/traits activate extra times or on demand
                         //   (params.what names the effect family)
  'limit_modifier',  // raises/sets rule caps ("max 20 Attacks per turn",
                     //   "resurrected a maximum of 15 times per battle")
  'other',
];

export const TIERS = ['small', 'moderate', 'large', 'massive', 'devastating'];
export const DIRECTIONS = ['up', 'down'];
// Stat-shaped scaling sources (pair with magnitude.scaleStat).
export const SCALE_SPECIALS = [
  'all', 'highest_stat', 'lowest_stat', 'total_stats', 'missing_health', 'level', 'rank', 'other',
];
// Non-stat quantities effects scale with — searchable ("scales with damage dealt").
export const SCALE_REFS = [
  'damage_dealt', 'damage_taken', 'healing_done', 'healing_received', 'amount_gained',
  'status_potency', 'minion_count', 'buff_count', 'debuff_count', 'turns_taken',
  'dead_creatures', 'spell_gems', 'creatures_in_party', 'infusions', 'other',
];
// Searchable action qualifiers: narrow facts worth faceting on their own.
export const QUALIFIERS = ['random', 'stolen', 'permanent'];
export const STATUS_KINDS = ['buff', 'debuff'];
// Direction of flow for damage_modifier / healing_modifier: outgoing vs incoming.
export const FLOWS = ['dealt', 'taken'];
const MAGNITUDE_KEYS = new Set([
  'amountPct', 'amountFlat', 'tier', 'scaleStat', 'scaleRef', 'scalePct',
  'per', 'perRank', 'direction', 'cap',
]);
const FLAG_KEYS = new Set(['stacks', 'manualCastOnly', 'unmodeled']);
const RULE_KEYS = new Set(['trigger', 'conditions', 'actions', 'chance', 'modifiesDefault']);
const TRIGGER_KEYS = new Set(['type', 'subject', 'params']);
const CONDITION_KEYS = new Set(['type', 'who', 'params']);
const ACTION_KEYS = new Set([
  'verb', 'actor', 'target', 'statuses', 'stats', 'statusKind', 'qualifiers', 'flow',
  'magnitude', 'params',
]);
const ANN_KEYS = new Set([
  'id', 'textHash', 'schemaVersion', 'provenance', 'machineTemplate',
  'rules', 'flags', 'waivedStatuses', 'notes', 'amplifies',
]);
// Verbs whose action always has a performer in game terms.
const ACTOR_REQUIRED_VERBS = new Set(['attack', 'cast']);

// Collect every status name referenced in searchable/param positions.
export function referencedStatuses(ann) {
  const found = new Set();
  const walk = v => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'status' && typeof val === 'string') found.add(val);
        else if (k === 'statuses' && Array.isArray(val)) val.forEach(s => found.add(s));
        else walk(val);
      }
    }
  };
  walk(ann.rules);
  return found;
}

export function validateAnnotation(ann, record, lex, corpus) {
  const errors = [];
  const err = m => errors.push(`${ann?.id ?? record?.id ?? '?'}: ${m}`);

  if (!ann || typeof ann !== 'object') return [`${record?.id}: annotation is not an object`];
  for (const k of Object.keys(ann)) if (!ANN_KEYS.has(k)) err(`unknown top-level key "${k}"`);
  if (ann.id !== record.id) err(`id "${ann.id}" does not match record "${record.id}"`);
  if (ann.schemaVersion !== SCHEMA_VERSION) err(`schemaVersion ${ann.schemaVersion} != ${SCHEMA_VERSION}`);
  if (!PROVENANCE.includes(ann.provenance)) err(`bad provenance "${ann.provenance}"`);

  // Meta-records ("Doubles the potency of these effects") point at the sibling
  // records they amplify; the index inherits those siblings' facets.
  if (ann.amplifies !== undefined) {
    if (!Array.isArray(ann.amplifies) || ann.amplifies.length === 0
        || !ann.amplifies.every(x => typeof x === 'string')) {
      err('amplifies must be a non-empty array of record ids');
    } else {
      for (const aid of ann.amplifies) {
        if (aid === ann.id) err('amplifies must not reference itself');
        else if (corpus && !corpus.has(aid)) err(`amplifies unknown id "${aid}"`);
      }
    }
  }

  const rules = ann.rules;
  if (!Array.isArray(rules)) { err('rules must be an array'); return errors; }
  if (rules.length === 0 && !ann.flags?.unmodeled && !ann.amplifies?.length && !record.meta?.loreOnly) {
    err('rules empty without flags.unmodeled, amplifies, or loreOnly record');
  }

  const relicScopeOk = record.id.startsWith('relic:');
  const checkRelicScope = (re, field, v) => {
    if (v === 'relic' && !relicScopeOk) re(`scope 'relic' in ${field} is only valid in relic records`);
  };
  rules.forEach((rule, i) => {
    const re = m => err(`rules[${i}]: ${m}`);
    for (const k of Object.keys(rule)) if (!RULE_KEYS.has(k)) re(`unknown key "${k}"`);
    const t = rule.trigger;
    if (!t || typeof t !== 'object') re('missing trigger');
    else {
      for (const k of Object.keys(t)) if (!TRIGGER_KEYS.has(k)) re(`unknown trigger key "${k}"`);
      if (!TRIGGER_TYPES.includes(t.type)) re(`bad trigger.type "${t.type}"`);
      if (t.subject !== undefined && !SCOPES.includes(t.subject)) re(`bad trigger.subject "${t.subject}"`);
      checkRelicScope(re, 'trigger.subject', t.subject);
      if (t.params?.spellClass !== undefined && !lex.classes.includes(t.params.spellClass)) {
        re(`trigger params.spellClass "${t.params.spellClass}" not a class`);
      }
      // "defends or provokes" is two trigger types, not one plus a note. Burying
      // the second in params made it unsearchable and half-rendered.
      if (t.params?.alsoAfter !== undefined) {
        re('trigger params.alsoAfter hides a second trigger type — use one rule per trigger');
      }
      // Faceted keys must never hold a compound string ("Attack, Defense or
      // Speed"): it silently produces no facets at all.
      if (typeof t.params?.stats === 'string') {
        re(`trigger params.stats must be an array, got "${t.params.stats}"`);
      }
      for (const s of Array.isArray(t.params?.stats) ? t.params.stats : []) {
        if (!lex.stats.includes(s) && !SCALE_SPECIALS.includes(s)) {
          re(`trigger params.stats "${s}" not a stat`);
        }
      }
    }
    for (const c of rule.conditions ?? []) {
      for (const k of Object.keys(c)) if (!CONDITION_KEYS.has(k)) re(`unknown condition key "${k}"`);
      if (!CONDITION_TYPES.includes(c.type)) re(`bad condition.type "${c.type}"`);
      if (c.who !== undefined && !SCOPES.includes(c.who)) re(`bad condition.who "${c.who}"`);
      checkRelicScope(re, 'condition.who', c.who);
      // Semi-structured params: when these conventional keys appear, their
      // values must come from the lexicons (facet derivation reads them).
      // Plural forms exist for conditions naming several at once ("your Imlers
      // and Imlings"); a bare compound string would skip faceting entirely.
      if (c.params?.class !== undefined && !lex.classes.includes(c.params.class)) {
        re(`condition params.class "${c.params.class}" not a class`);
      }
      for (const cl of c.params?.classes ?? []) {
        if (!lex.classes.includes(cl)) re(`condition params.classes "${cl}" not a class`);
      }
      if (c.params?.race !== undefined && !lex.families.includes(c.params.race)) {
        re(`condition params.race "${c.params.race}" not a known family`);
      }
      for (const r of c.params?.races ?? []) {
        if (!lex.families.includes(r)) re(`condition params.races "${r}" not a known family`);
      }
      if (c.params?.spellClass !== undefined && !lex.classes.includes(c.params.spellClass)) {
        re(`condition params.spellClass "${c.params.spellClass}" not a class`);
      }
      if (c.type === 'stat_comparison' && c.params?.stat !== undefined
          && !lex.stats.includes(c.params.stat) && !SCALE_SPECIALS.includes(c.params.stat)) {
        re(`condition params.stat "${c.params.stat}" not a stat`);
      }
    }
    const actions = rule.actions;
    if (!Array.isArray(actions) || actions.length === 0) re('actions must be a non-empty array');
    else actions.forEach((a, j) => {
      const ae = m => re(`actions[${j}]: ${m}`);
      for (const k of Object.keys(a)) if (!ACTION_KEYS.has(k)) ae(`unknown action key "${k}"`);
      if (!ACTION_VERBS.includes(a.verb)) ae(`bad verb "${a.verb}"`);
      if (a.actor !== undefined && !SCOPES.includes(a.actor)) ae(`bad actor "${a.actor}"`);
      // Omitted actor = ambient (no performer). Verbs with an intrinsic
      // performer must name one explicitly.
      if (ACTOR_REQUIRED_VERBS.has(a.verb) && a.actor === undefined) {
        ae(`verb "${a.verb}" requires an explicit actor (holder/caster/trigger_subject/...)`);
      }
      if (a.target !== undefined && !SCOPES.includes(a.target)) ae(`bad target "${a.target}"`);
      checkRelicScope(ae, 'actor', a.actor);
      checkRelicScope(ae, 'target', a.target);
      if (a.statusKind !== undefined && !STATUS_KINDS.includes(a.statusKind)) ae(`bad statusKind "${a.statusKind}"`);
      if (a.flow !== undefined && !FLOWS.includes(a.flow)) ae(`bad flow "${a.flow}"`);
      for (const q of a.qualifiers ?? []) {
        if (!QUALIFIERS.includes(q)) ae(`unknown qualifier "${q}"`);
      }
      for (const s of a.statuses ?? []) {
        if (!lex.statusNames.includes(s)) ae(`unknown status "${s}"`);
      }
      for (const s of a.stats ?? []) {
        if (!lex.stats.includes(s) && !SCALE_SPECIALS.includes(s)) ae(`unknown stat "${s}"`);
      }
      // Action params that facet derivation reads must hold real lexicon
      // names — an unvalidated one silently becomes a garbage facet value.
      for (const k of ['sourceClass', 'vsClass', 'spellClass']) {
        if (a.params?.[k] !== undefined && !lex.classes.includes(a.params[k])) {
          ae(`params.${k} "${a.params[k]}" not a class`);
        }
      }
      if (a.params?.sourceRace !== undefined && !lex.families.includes(a.params.sourceRace)) {
        ae(`params.sourceRace "${a.params.sourceRace}" not a known family`);
      }
      const m = a.magnitude;
      if (m !== undefined) {
        for (const k of Object.keys(m)) if (!MAGNITUDE_KEYS.has(k)) ae(`unknown magnitude key "${k}"`);
        if (m.tier !== undefined && !TIERS.includes(m.tier)) ae(`bad tier "${m.tier}"`);
        if (m.direction !== undefined && !DIRECTIONS.includes(m.direction)) ae(`bad direction "${m.direction}"`);
        if (m.scaleStat !== undefined && !lex.stats.includes(m.scaleStat) && !SCALE_SPECIALS.includes(m.scaleStat)) {
          ae(`bad scaleStat "${m.scaleStat}"`);
        }
        if (m.scaleRef !== undefined && !SCALE_REFS.includes(m.scaleRef)) ae(`bad scaleRef "${m.scaleRef}"`);
        if (m.per !== undefined && typeof m.per !== 'string') ae('magnitude.per must be a string');
      }
    });
    if (rule.chance !== undefined && !(typeof rule.chance === 'number' && rule.chance > 0 && rule.chance <= 100)) {
      re(`bad chance ${rule.chance}`);
    }
  });

  if (ann.flags !== undefined) {
    for (const k of Object.keys(ann.flags)) if (!FLAG_KEYS.has(k)) err(`unknown flag "${k}"`);
    if ('stacks' in ann.flags && ann.flags.stacks !== false) err('flags.stacks may only be false');
  }
  return errors;
}

// A status "appears" if its canonical name or any alias matches ("Stone"/"Stoned").
export function statusInText(lex, name, text) {
  return (lex.statusForms[name] ?? [name]).some(form => termRegex(form).test(text));
}

// Both-ways status evidence check: every status the annotation claims must
// appear in the text; every status in the text must be referenced or waived.
// noText records (self-descriptive realm properties) match against their name
// and skip the unclaimed-mention direction.
export function crossCheckStatuses(ann, record, lex) {
  const errors = [];
  const claimed = referencedStatuses(ann);
  const waived = new Set(ann.waivedStatuses ?? []);
  const hay = record.meta?.noText ? `${record.name}. ${record.text}` : record.text;
  for (const s of claimed) {
    if (!statusInText(lex, s, hay)) {
      errors.push(`${record.id}: claims status "${s}" not present in text`);
    }
  }
  if (!record.meta?.noText) {
    for (const s of lex.statusNames) {
      if (statusInText(lex, s, hay) && !claimed.has(s) && !waived.has(s)) {
        errors.push(`${record.id}: text mentions "${s}" but annotation neither references nor waives it`);
      }
    }
  }
  return errors;
}
