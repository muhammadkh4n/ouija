import type { Guard, GuardContext, GuardResult } from '@ouija-dev/types';

/**
 * Evaluate all guards against the provided context.
 * Returns one GuardResult per guard — callers inspect .passed to determine overall success.
 * Guards are NOT short-circuited here: all are evaluated so the caller can report all failures.
 * This function is PURE: no I/O, no side effects.
 */
export function evaluateGuards(guards: Guard[], context: GuardContext): GuardResult[] {
  return guards.map((guard) => evaluateGuard(guard, context));
}

function evaluateGuard(guard: Guard, context: GuardContext): GuardResult {
  switch (guard.type) {
    case 'min_description_length': {
      const minLen =
        typeof guard.value === 'number'
          ? guard.value
          : parseInt(String(guard.value), 10);
      const actual = context.cardDescription.length;
      const passed = actual >= minLen;
      return {
        guardType: guard.type,
        passed,
        ...(passed ? {} : { reason: `Description is ${actual} chars, need at least ${minLen}` }),
      };
    }

    case 'has_label': {
      const label = String(guard.value);
      const passed = context.cardLabels.includes(label);
      return {
        guardType: guard.type,
        passed,
        ...(passed ? {} : { reason: `Missing required label "${label}"` }),
      };
    }

    case 'has_assignee': {
      const passed = context.cardAssignees.length > 0;
      return {
        guardType: guard.type,
        passed,
        ...(passed ? {} : { reason: 'Card has no assignee' }),
      };
    }

    default: {
      const _exhaustive: never = guard.type;
      return {
        guardType: String(_exhaustive),
        passed: false,
        reason: `Unknown guard type: ${String(_exhaustive)}`,
      };
    }
  }
}
