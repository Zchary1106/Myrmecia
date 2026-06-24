## Overview

Below is a **generic, educational explanation** of how a CPU executes an `ADD` instruction, using a simple example:

**`ADD R1, R2`**  
Meaning: **`R1 = R1 + R2`**

This explanation separates:

- **Architectural view**: what the instruction means to a programmer
- **Hardware view**: how the CPU actually carries it out internally

The model is intentionally simplified so it is easy to follow, but I’ll also note where real CPUs differ.

---

## 1. Architectural meaning of `ADD R1, R2`

At the instruction set level, `ADD R1, R2` usually means:

1. Read the current value in `R1`
2. Read the current value in `R2`
3. Add them together
4. Store the result back into `R1`
5. Update condition/status flags if the architecture defines them

Example:

- `R1 = 5`
- `R2 = 3`

After `ADD R1, R2`:

- `R1 = 8`
- `R2 = 3` unchanged

That is the **architectural effect**.  
Now let’s look at how hardware makes that happen.

---

## 2. Main CPU parts involved

Before the step-by-step flow, here are the components that matter:

- **Program Counter (PC)**  
  Holds the memory address of the next instruction to fetch.

- **Memory**  
  Stores program instructions and possibly data.

- **Instruction Register (IR)** or decode path  
  Temporarily holds the fetched instruction so it can be decoded.

- **Control Unit / Instruction Decoder**  
  Interprets the instruction bits and generates control signals telling the rest of the CPU what to do.

- **Register File**  
  The bank of CPU registers (`R1`, `R2`, etc.).

- **ALU (Arithmetic Logic Unit)**  
  Performs arithmetic and logic operations such as addition.

- **Status/Flags Register**  
  Stores condition flags like Zero, Carry, Overflow, Negative/Sign.

- **Buses / Datapaths**  
  Internal paths that move addresses, instructions, operands, and results between CPU components.

---

## 3. Step-by-step: how the CPU executes `ADD R1, R2`

## Step 1: The Program Counter points to the instruction

The CPU begins with the **PC** containing the address of the next instruction.

For example:

- `PC = 0x1000`

This means the next instruction is stored at memory address `0x1000`.

The control unit starts the **fetch** phase by sending the PC’s value onto the **address bus** or internal address path.

---

## Step 2: Instruction fetch from memory

The CPU requests the instruction stored at the address in the PC.

Conceptually:

- Memory receives address `0x1000`
- Memory returns the instruction bits that encode `ADD R1, R2`

Those instruction bits travel back over the **data bus** or instruction path into the CPU.

In a simple CPU, the fetched instruction is loaded into an **Instruction Register (IR)**.

So now:

- `IR = encoding of ADD R1, R2`

At this point, the CPU has successfully fetched the instruction.

---

## Step 3: The PC is updated for the next instruction

Once the fetch is underway or complete, the CPU updates the **PC** so it points to the following instruction.

If the instruction length is fixed and one word long, this might be as simple as:

- `PC = PC + 1`
or
- `PC = PC + 4`

depending on the architecture’s instruction size.

So if each instruction is 4 bytes:

- Old `PC = 0x1000`
- New `PC = 0x1004`

This means that unless something changes control flow later, the next fetch will come from `0x1004`.

Important note: in some CPUs, the PC is incremented before decode finishes; in others, this is done in a different stage. But conceptually, the CPU prepares the next instruction address here.

---

## Step 4: Decode the instruction

Now the **control unit** or **instruction decoder** examines the bits in the instruction register.

It determines:

- the **opcode**: this is an `ADD`
- the **source/destination register fields**: use `R1` and `R2`
- the **operation type**: arithmetic addition
- where the result should go: back into `R1`
- whether flags should be updated

This is the point where raw bits become a meaningful action.

For example, the decoder may derive internal control signals like:

- read register `R1`
- read register `R2`
- select ALU operation = ADD
- write result to `R1`
- update status flags

The decoder does not itself perform the math. It tells other hardware blocks what they must do.

---

## Step 5: Read the operands from the register file

Next, the CPU must obtain the actual input values.

Since the instruction is `ADD R1, R2`, the register file is asked to output:

- value stored in `R1`
- value stored in `R2`

Suppose:

- `R1 = 00000101` (binary for 5)
- `R2 = 00000011` (binary for 3)

The register file places those values onto internal datapaths.

At this point the CPU has the two operands needed for the addition.

---

## Step 6: Route operands to the ALU

The datapath now sends the retrieved register values into the ALU’s input ports.

Typical conceptual setup:

- ALU input A ← value from `R1`
- ALU input B ← value from `R2`

At the same time, the control unit asserts a signal telling the ALU which operation to perform:

- **ALU operation = ADD**

So now the ALU has:

- operand A = 5
- operand B = 3
- function = addition

---

## Step 7: The ALU performs binary addition

The ALU adds the two binary values.

Example:

```text
  00000101
+ 00000011
-----------
  00001000
```

So the result is:

- `8`

Inside the ALU, this is done using digital logic, typically a chain of adders built from logic gates.

At the hardware level, each bit position is added along with any incoming carry from the previous bit. That is how binary addition works physically in the circuit.

So the ALU produces:

- **result output**
- possibly extra information such as **carry out**
- information used for **flag calculation**

---

## Step 8: Update condition/status flags

After or during the ALU operation, the CPU updates status flags in the **flags register** or **status register**.

Common flags include:

- **Zero (Z)**: set if the result is zero
- **Carry (C)**: set if there was a carry out of the most significant bit in unsigned addition
- **Overflow (V or O)**: set if signed arithmetic overflow occurred
- **Negative/Sign (N or S)**: set if the result’s top bit indicates a negative value in signed representation

Using the example `5 + 3 = 8`:

- Zero = 0, because result is not zero
- Carry = 0, assuming no carry out
- Overflow = 0, assuming result fits in range
- Negative = 0, because 8 is positive

These flags matter because later instructions may check them, such as conditional branches like “jump if zero”.

Important caveat: exact flag behavior depends on the CPU architecture. Some `ADD` forms update flags automatically, some only in specific variants.

---

## Step 9: Write the result back to the destination register

The ALU’s output is now sent back through the datapath to the register file.

Because the destination is `R1`, the control unit enables a write to `R1`.

So:

- old `R1 = 5`
- new `R1 = 8`

`R2` remains unchanged.

This is the **write-back** stage.

At the architectural level, this is the moment where the CPU state visibly reflects the result of the instruction.

---

## Step 10: Begin the next instruction

Now the current `ADD` instruction is complete.

Since the PC was already updated to point to the next instruction address, the CPU proceeds to fetch the next instruction from memory.

So the overall cycle continues:

1. fetch
2. decode
3. execute
4. write back
5. next instruction

---

## 4. Full example in one flow

Suppose the machine state starts as:

- `PC = 0x1000`
- `Memory[0x1000] = ADD R1, R2`
- `R1 = 5`
- `R2 = 3`

Then execution proceeds like this:

1. **Fetch**  
   CPU reads memory at address `0x1000`

2. **Load instruction**  
   `ADD R1, R2` enters the instruction register / decode path

3. **Advance PC**  
   `PC` becomes `0x1004` assuming 4-byte instructions

4. **Decode**  
   CPU recognizes opcode `ADD`, source/destination registers `R1` and `R2`

5. **Read operands**  
   Register file outputs:
   - `R1 = 5`
   - `R2 = 3`

6. **Execute in ALU**  
   `5 + 3 = 8`

7. **Update flags**  
   Zero=0, Carry=0, Overflow=0, Negative=0

8. **Write back**  
   Result `8` is written into `R1`

9. **Continue**  
   CPU fetches the instruction at `0x1004`

Final state:

- `R1 = 8`
- `R2 = 3`
- `PC = 0x1004` or beyond depending on exact timing
- flags updated appropriately

---

## 5. What is happening electrically or in hardware?

Conceptually, the steps above sound sequential, but in hardware they correspond to control signals and data movement:

- The **PC** drives an address line
- **Memory** outputs instruction bits
- The **decoder** turns bit fields into control signals
- The **register file** places operand values onto internal buses
- Multiplexers and datapaths route values into the **ALU**
- The **ALU** computes the sum using combinational logic
- The result is latched into a destination register on a clock edge
- Flags are latched into the status register

In a clocked CPU, state changes such as:

- loading the instruction register
- updating the PC
- writing `R1`
- updating flags

usually happen on specific **clock edges**.

So one useful way to think about it is:

- **Combinational logic** computes what should happen
- **Sequential logic** stores the new state at clock boundaries

---

## 6. Simple teaching CPU vs real CPU

## A. Non-pipelined or teaching CPU

In a simplified educational CPU, the instruction may execute as neat stages:

1. Fetch
2. Decode
3. Read operands
4. Execute
5. Write back

This makes it easy to understand because one instruction is conceptually processed at a time.

---

## B. Pipelined CPU

In a real pipelined CPU, these stages overlap.

While one instruction is being executed in the ALU:

- the next instruction may already be decoding
- another instruction may already be fetching from memory

So the CPU is not literally waiting for one instruction to fully finish before touching the next one.

However, for a **single instruction’s lifecycle**, the same logical stages still exist:
- fetch
- decode
- operand read
- execute
- write-back

They are just overlapped with other instructions.

---

## C. Cached systems

Real CPUs often fetch instructions from **cache** rather than directly from main memory.

So “fetch from memory” often really means:

1. check instruction cache
2. if hit, fetch quickly
3. if miss, fetch from a lower cache level or RAM

Likewise, if an `ADD` instruction needs a memory operand in some architectures, that operand may come from a data cache.

From the programmer’s perspective, it is still “read instruction/data from memory,” but physically the source may be a cache hierarchy.

---

## D. Register-register vs register-memory forms

Our example used a **register-register** instruction:

- `ADD R1, R2`

This is simpler because both operands are already in CPU registers.

Some architectures also support **register-memory** forms, conceptually like:

- `ADD R1, [address]`

In that case, the CPU must do extra work:

1. compute or decode the memory address
2. read the operand from memory/cache
3. send that value to the ALU
4. perform the add
5. write back the result

That makes execution more complex and usually slower than pure register-register addition.

---

## E. Complex modern CPUs

Modern high-performance CPUs may do much more internally:

- break instructions into **micro-operations**
- rename registers
- execute instructions out of order
- speculate on branches
- retire results in program order

So internally, a modern CPU may not execute `ADD` in the simple textbook sequence exactly as shown.

But architecturally, the visible effect is still the same:

- read operands
- compute sum
- write result
- update flags if defined

The simplified model remains the right starting point for understanding.

---

## 7. Why flag behavior matters

Flags are a key part of `ADD` because addition can produce information beyond just the numeric result.

For example:

### Zero flag
If:

- `R1 = 0`
- `R2 = 0`

Then result is `0`, so Zero may be set.

### Carry flag
In unsigned arithmetic with limited bit width, adding two large numbers may produce a carry out.

Example in 8 bits:

```text
11111111   (255)
00000001   (1)
--------
1 00000000
```

The stored 8-bit result is `00000000`, and a **carry** occurred.

### Overflow flag
Signed overflow is different from carry.  
For example in 8-bit signed arithmetic:

```text
01111111   (+127)
00000001   (+1)
--------
10000000
```

The bit pattern now looks like `-128` in two’s complement, which means signed overflow occurred.

### Negative/Sign flag
If the most significant bit of the result is 1 in two’s complement representation, the CPU may mark the result as negative.

---

## 8. Compact summary

For a simple CPU, `ADD R1, R2` executes like this:

1. **PC** holds the address of the instruction
2. CPU **fetches** the instruction from memory
3. CPU **updates PC** to the next instruction
4. **Decoder** recognizes `ADD` and identifies `R1` and `R2`
5. **Register file** supplies the values in `R1` and `R2`
6. **Datapath** sends both operands to the **ALU**
7. **ALU** performs binary addition
8. **Flags** such as Zero/Carry/Overflow/Negative are updated
9. **Result** is written back to `R1`
10. CPU moves on to the next instruction

---

## 9. One-sentence takeaway

An `ADD` instruction is executed by fetching its bits from memory, decoding them into control signals, reading operands from registers or memory, sending them through the datapath to the ALU for binary addition, updating flags, writing the result back, and then continuing with the next instruction.

If you want, I can also provide:
1. a **GitHub-ready feature spec version**,  
2. a **beginner-friendly version**, or  
3. a **clock-cycle / pipeline diagram** of the same process.