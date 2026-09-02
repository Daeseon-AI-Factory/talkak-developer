//! Token totals for a bound record, in the agent's own numbers.
//!
//! No cost is derived: a subscription has no per-token bill, and inventing one would be a lie the
//! summary panel then repeats. An agent whose record carries no counts leaves the whole value
//! absent, and the renderer labels that honestly rather than showing zeros.

use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UsageTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// How many agent replies contributed, so a reader can tell "0 tokens" from "not recorded".
    pub messages: u64,
}

/// One reply's counts, already mapped from the provider's own field names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct UsageSample {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
}

impl UsageTotals {
    /// Claude-style records count each reply separately: sum them.
    pub(crate) fn add(&mut self, sample: UsageSample) {
        self.input_tokens = self.input_tokens.saturating_add(sample.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(sample.output_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(sample.cache_read_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(sample.cache_creation_tokens);
        self.messages = self.messages.saturating_add(1);
    }

    /// Codex-style records repeat a running session total: the latest one replaces the rest.
    pub(crate) fn replace(&mut self, total: UsageSample) {
        self.input_tokens = total.input_tokens;
        self.output_tokens = total.output_tokens;
        self.cache_read_tokens = total.cache_read_tokens;
        self.cache_creation_tokens = total.cache_creation_tokens;
        self.messages = self.messages.saturating_add(1);
    }
}

/// Reads one numeric field of a provider usage object, tolerating a missing or non-integer value.
pub(crate) fn usage_field(usage: &serde_json::Value, key: &str) -> u64 {
    usage.get(key).and_then(|value| value.as_u64()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn samples_sum_and_count_replies() {
        let mut totals = UsageTotals::default();
        totals.add(UsageSample {
            input_tokens: 2,
            output_tokens: 1_204,
            cache_read_tokens: 21_642,
            cache_creation_tokens: 24_092,
        });
        totals.add(UsageSample {
            input_tokens: 3,
            output_tokens: 10,
            cache_read_tokens: 0,
            cache_creation_tokens: 1,
        });
        assert_eq!(
            totals,
            UsageTotals {
                input_tokens: 5,
                output_tokens: 1_214,
                cache_read_tokens: 21_642,
                cache_creation_tokens: 24_093,
                messages: 2,
            }
        );
    }

    #[test]
    fn a_running_total_replaces_instead_of_summing() {
        let mut totals = UsageTotals::default();
        totals.replace(UsageSample {
            input_tokens: 18_004,
            output_tokens: 599,
            cache_read_tokens: 11_008,
            cache_creation_tokens: 0,
        });
        totals.replace(UsageSample {
            input_tokens: 23_111,
            output_tokens: 1_168,
            cache_read_tokens: 9_984,
            cache_creation_tokens: 0,
        });
        assert_eq!(totals.input_tokens, 23_111);
        assert_eq!(totals.output_tokens, 1_168);
        assert_eq!(totals.cache_read_tokens, 9_984);
        assert_eq!(totals.messages, 2);
    }

    #[test]
    fn missing_or_odd_fields_read_as_zero_and_names_are_camel_case() {
        let usage = serde_json::json!({"input_tokens": 7, "output_tokens": "many"});
        assert_eq!(usage_field(&usage, "input_tokens"), 7);
        assert_eq!(usage_field(&usage, "output_tokens"), 0);
        assert_eq!(usage_field(&usage, "cache_read_input_tokens"), 0);

        let json = serde_json::to_value(UsageTotals {
            input_tokens: 1,
            output_tokens: 2,
            cache_read_tokens: 3,
            cache_creation_tokens: 4,
            messages: 5,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "inputTokens": 1,
                "outputTokens": 2,
                "cacheReadTokens": 3,
                "cacheCreationTokens": 4,
                "messages": 5
            })
        );
    }
}
