#[cfg(test)]
mod tests {
    use syndicate_shared::{StartPolicyAction, StartPolicyResult, StartPolicyTrigger, EVENT_SCHEMA_VERSION};

    #[test]
    fn start_policy_result_roundtrip() {
        let result = StartPolicyResult::start(StartPolicyTrigger::MaxFill);
        assert_eq!(result.schema_version, EVENT_SCHEMA_VERSION);
        assert_eq!(result.action, StartPolicyAction::Start);
        assert_eq!(result.trigger, Some(StartPolicyTrigger::MaxFill));
    }

    #[test]
    fn void_result_includes_reason() {
        let result = StartPolicyResult::void("not enough players", StartPolicyTrigger::FillDeadline);
        assert_eq!(result.action, StartPolicyAction::Void);
        assert_eq!(result.reason.as_deref(), Some("not enough players"));
    }
}
