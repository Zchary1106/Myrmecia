# Account model catalog

The model registry is an inventory, not an account entitlement list. Builtin,
custom, historical, and other-provider entries must not be presented as verified
Copilot account choices.

## Copilot selection

- The execution picker uses the current Copilot SDK model-discovery response.
- A response containing only `auto` is authoritative. It is not expanded with
  cached models or a fixed compatibility list.
- Discovery failure returns no selectable account models. The homepage shows an
  error, blocks submission, and offers refresh. A discovery error alone does not
  imply that the GitHub account has logged out.
- Organization-disabled and locally disabled models cannot be selected.
- Successful snapshots mark missing discovered models unavailable, preserving
  their registry records and the operator's enabled/disabled preference.
- Model management separates current account choices from historical, builtin,
  disabled, and other-provider inventory.
- New task, Supervisor, and Team submissions recheck the effective Copilot model,
  including the configured default when no explicit model is supplied.
- A removed explicit model or default is rejected rather than silently replaced
  with another model.

Discovery is bounded to 15 seconds. Unverifiable submissions return
`MODEL_DISCOVERY_UNAVAILABLE` (503); unavailable task choices return
`INVALID_MODEL` (400).

## Verification boundary

SDK discovery is not a successful inference test and need not mirror the model
picker of every GitHub product. The UI reflects the local Copilot CLI/SDK catalog,
not a scraped GitHub website list. Billing, quota, and request-time availability
still require a real invocation to verify. Refreshing the list does not send an
inference request.
