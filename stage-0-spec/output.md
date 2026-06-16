## clarify
1. **Problem**
- Create a detailed, step-by-step explanation of how a CPU executes an `ADD` instruction.
- The explanation should cover the full instruction lifecycle, from fetching the instruction from memory through decoding, operand access, ALU execution, flag updates, write-back, and program counter advancement.
- It should be understandable to a technical audience and detailed enough to distinguish between conceptual CPU stages and what happens in hardware.
- Unknowns:
  - Target audience level is not explicitly defined.
  - CPU model is not specified: generic CPU, x86-like, ARM-like, or simple teaching architecture.
  - Depth of hardware detail is unclear: whether to include registers, buses, control unit, clock cycles, pipelining, cache, and micro-ops.
- Non-goals:
  - Implementing an actual CPU simulator.
  - Covering every instruction type.
  - Providing a vendor-specific microarchitectural deep dive unless explicitly requested.

2. **Acceptance criteria**
- Explains the execution of an `ADD` instruction in sequential steps.
- Includes, at minimum:
  - instruction fetch
  - program counter usage
  - instruction decode
  - operand retrieval
  - ALU addition
  - result write-back
  - status/condition flag updates
- Clarifies the role of key CPU components such as:
  - registers
  - control unit
  - ALU
  - memory
  - buses or data paths
- Distinguishes between:
  - architectural view (what the instruction means)
  - hardware execution view (how the CPU carries it out)
- Uses one concrete example, such as `ADD R1, R2` or equivalent.
- Notes important variations or caveats, such as:
  - register-register vs register-memory forms
  - pipelined vs non-pipelined CPUs
  - simplified teaching model vs real modern CPUs
- Written in a detailed but organized format suitable for documentation or educational content.

3. **Implementation tasks**
- Define the intended explanation scope:
  - generic CPU model
  - educational/simple CPU
  - or modern CPU with caveats
- Choose a concrete sample instruction format, e.g. `ADD R1, R2` meaning `R1 = R1 + R2`.
- Draft the explanation in ordered stages:
  - Step 1: Fetch instruction from memory using the program counter
  - Step 2: Increment/update the program counter
  - Step 3: Decode opcode and identify operands
  - Step 4: Read operand values from registers or memory
  - Step 5: Route operands to the ALU
  - Step 6: Perform binary addition
  - Step 7: Update condition flags
  - Step 8: Write result back to destination
  - Step 9: Continue to next instruction
- Add a short section explaining what changes in:
  - pipelined CPUs
  - cached systems
  - complex instruction set architectures
- Review for clarity, correctness, and consistency of terminology.

4. **Validation**
- Confirm the explanation contains a full end-to-end instruction path.
- Verify each required CPU component is mentioned and used correctly.
- Check that the sample instruction is followed consistently through all steps.
- Ensure flag behavior is described accurately at a high level, including examples like zero, carry, overflow, or negative/sign where relevant.
- Validate that caveats do not contradict the main simplified explanation.
- Confirm the content is detailed enough to satisfy “in detail” without becoming architecture-specific unless intended.

5. **Release notes impact**
- Documentation/educational content only.
- No user-facing product behavior changes.
- No API, UI, or runtime impact.

## decompose
1. **Problem**
- Create a detailed feature spec for educational/documentation content that explains, step by step, how a CPU executes an `ADD` instruction.
- The spec should describe the full instruction lifecycle in an understandable but technically accurate way, from instruction fetch through decode, operand access, ALU execution, flag updates, write-back, and movement to the next instruction.
- The explanation should use a concrete example such as `ADD R1, R2` and distinguish between the architectural meaning of the instruction and the hardware-level actions taken by the CPU.
- Scope should remain generic/educational rather than vendor-specific, while briefly noting how real CPUs may differ.

2. **Acceptance criteria**
- Includes an ordered, step-by-step explanation of `ADD` execution.
- Covers these stages explicitly:
  - instruction fetch
  - program counter usage/update
  - decode
  - operand retrieval
  - ALU addition
  - flag/status updates
  - result write-back
  - transition to the next instruction
- Names and explains the role of:
  - registers
  - ALU
  - control unit / decoder
  - memory
  - buses or datapaths
- Uses one concrete instruction example consistently.
- Separates:
  - architectural view: what `ADD` means
  - implementation view: how hardware performs it
- Includes brief caveats for:
  - register-register vs register-memory variants
  - simple non-pipelined CPU vs pipelined/modern CPUs
- Written in organized documentation/spec form.

3. **Implementation tasks**
- Define the instructional scope as a generic educational CPU model.
- Choose a canonical example, e.g. `ADD R1, R2` where `R1 = R1 + R2`.
- Draft the feature spec sections:
  - overview/objective
  - example instruction semantics
  - execution stages in order
  - hardware components involved
  - flags affected
  - caveats/real-world variations
- For the execution stages, document:
  - PC points to instruction address
  - instruction fetched from memory
  - PC advanced or prepared for next instruction
  - decoder interprets opcode and operand fields
  - register file/memory provides operands
  - operands routed to ALU
  - ALU performs binary addition
  - condition flags updated
  - result written to destination register/memory
  - CPU proceeds to next fetch
- Add a short note on implementation differences in:
  - pipelined CPUs
  - cached systems
  - more complex ISAs
- Review wording for technical correctness and readability.

4. **Validation**
- Confirm the spec describes the full end-to-end lifecycle of one `ADD` instruction.
- Verify every required stage appears in the correct logical order.
- Check that the concrete example is used consistently throughout.
- Ensure CPU components are referenced accurately and tied to their roles.
- Validate that flag behavior is described at a high level without architecture-specific inaccuracies.
- Confirm caveats are clearly marked as variations, not contradictions to the main model.
- Ensure the result is brief as a feature spec, not a full tutorial.

5. **Release notes impact**
- Documentation/content addition only.
- No product behavior, API, UI, or system runtime changes.
- Release notes likely unnecessary unless documentation updates are tracked separately.

## output
1. **Problem**
- Create a brief, GitHub-ready feature spec for documentation/educational content that explains, step by step, how a CPU executes an `ADD` instruction in detail.
- The content should walk through the full instruction lifecycle using a clear example such as `ADD R1, R2`, covering:
  - instruction fetch
  - program counter handling
  - instruction decode
  - operand access
  - ALU execution
  - flag/status updates
  - result write-back
  - advance to the next instruction
- The explanation should be technically accurate, organized, and understandable for a technical reader, while remaining architecture-agnostic and educational rather than vendor-specific.

2. **Acceptance criteria**
- [ ] Spec defines the scope as a generic educational CPU model.
- [ ] Spec uses one concrete example consistently, such as `ADD R1, R2` meaning `R1 = R1 + R2`.
- [ ] Spec includes an ordered explanation of these stages:
  - [ ] fetch
  - [ ] PC usage/update
  - [ ] decode
  - [ ] operand retrieval
  - [ ] ALU addition
  - [ ] flags/status update
  - [ ] write-back
  - [ ] next-instruction continuation
- [ ] Spec identifies and explains the role of:
  - [ ] registers
  - [ ] ALU
  - [ ] control unit / instruction decoder
  - [ ] memory
  - [ ] buses or datapaths
- [ ] Spec distinguishes between:
  - [ ] architectural meaning of the instruction
  - [ ] hardware actions that implement it
- [ ] Spec includes brief caveats for:
  - [ ] register-register vs register-memory forms
  - [ ] simple single-cycle/multi-cycle CPU vs pipelined modern CPU
- [ ] Spec is concise and formatted for GitHub issue/PRD use, not a full tutorial.

3. **Implementation tasks**
- [ ] Write a short overview stating the objective of the content.
- [ ] Define the example instruction and semantics:
  - [ ] e.g. `ADD R1, R2`
  - [ ] explain that the result is stored in `R1`
- [ ] Draft the step-by-step execution flow:
  - [ ] PC points to instruction address
  - [ ] instruction is fetched from memory
  - [ ] instruction is placed into an instruction register / decode path
  - [ ] PC is incremented or otherwise updated
  - [ ] decoder interprets opcode and operand fields
  - [ ] register file and/or memory supplies operands
  - [ ] datapath routes operands into the ALU
  - [ ] ALU performs binary addition
  - [ ] status flags are computed and updated
  - [ ] result is written back to destination
  - [ ] CPU begins processing the next instruction
- [ ] Add a small section on hardware components involved.
- [ ] Add a small section on condition flags affected:
  - [ ] zero
  - [ ] carry
  - [ ] overflow
  - [ ] sign/negative
- [ ] Add caveats on how real CPUs may differ:
  - [ ] pipelining
  - [ ] caches
  - [ ] ISA-specific differences
- [ ] Review for clarity, correctness, and consistent terminology.

4. **Validation**
- [ ] Confirm the spec covers the full lifecycle of a single `ADD` instruction end to end.
- [ ] Confirm all required stages appear in logical order.
- [ ] Confirm the chosen instruction example is used consistently throughout.
- [ ] Verify each CPU component is named correctly and tied to its role.
- [ ] Verify flag behavior is described at a correct high level without architecture-specific errors.
- [ ] Ensure caveats are presented as variations on the simplified model, not contradictions.
- [ ] Ensure final output is brief, actionable, and GitHub-ready.

5. **Release notes impact**
- Documentation/content only.
- No API, UI, runtime, or behavior changes.
- Release notes not required unless documentation changes are tracked separately.