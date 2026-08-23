# Foundations

Date of record: 2026-08-23. This document states what prior work has already settled about the class of defect T27 hit, what our own six measurements do and do not support, and what follows for the design. Every claim about prior work carries a citation. Every claim about our system carries the measurement or the file and line it came from.

Provenance note, stated up front because it bears on how much weight each sentence carries. Bibliographic details and quoted phrases below were verified against primary sources by the survey strands that produced them; in this session I independently re-verified eight of them (listed in the final section) and re-read the load-bearing lines of `/Users/playra/t27/bootstrap/src/compiler.rs` and `/Users/playra/t27/bootstrap/src/main.rs` read-only. Where a figure sits in a paper's body rather than in an abstract I could reach, I say so.

---

## What the literature already knows

Organised by what it lets us stop arguing about.

### 1. What a compiler owes its user when it cannot compile

Settled. The field's minimal definition of a verified compiler is not "the compiler is correct" but "the compiler is correct or loud": `Comp(S) = OK(C)` implies `S ≈ C`, with `Error` always a permitted outcome. Leroy states the target as, in his words, "the compiler never silently produces incorrect code", and notes that a compiler which always returns `Error` is trivially verified though useless, because success rate is a quality-of-implementation matter addressed by testing rather than a correctness matter [Xavier Leroy, "Formal verification of a realistic compiler", *Communications of the ACM* 52(7):107–115, 2009, DOI 10.1145/1538788.1538814, §2.2].

Consequence we can stop debating: making a t27c gate exit non-zero cannot damage correctness. Refusing more often is still verified. The cost of fail-closed is usability, and the literature says so explicitly.

The placement precedent is also settled. CompCert's parser validator runs at compile-compile time, when CompCert itself is built, and on failure the build aborts — before the compiler reaches users [Jacques-Henri Jourdan, François Pottier, Xavier Leroy, "Validating LR(1) Parsers", ESOP 2012, LNCS 7211, pp. 397–416, DOI 10.1007/978-3-642-28869-2_20, §5, §7].

### 2. Where compiler defects actually live

Settled, and it is the front end. Three CPU-years of random differential testing found six silent wrong-code bugs in CompCert, all in the unverified front end, and none in the verified middle end [Xuejun Yang, Yang Chen, Eric Eide, John Regehr, "Finding and understanding bugs in C compilers", PLDI 2011, pp. 283–294, DOI 10.1145/1993498.1993532, §3.1]. Equivalence Modulo Inputs, a different oracle five years later, reproduced the boundary: confirmed CompCert findings in the front end, none in the verified components [Vu Le, Mehrdad Afshari, Zhendong Su, "Compiler Validation via Equivalence Modulo Inputs", PLDI 2014, pp. 216–226, DOI 10.1145/2594291.2594334].

A dedicated audit of CompCert's trusted computing base confirms the structural reason: preprocessing, lexing, parsing and typechecking are, in the authors' phrase, "Most of them are unverified, but trusted", and the surviving bugs found were in front-end elaboration, back-ends and the assembly printer rather than in the proved core [David Monniaux, Sylvain Boulmé, "The Trusted Computing Base of the CompCert Verified Compiler", ESOP 2022, LNCS 13240, pp. 204–233, DOI 10.1007/978-3-030-99336-8_8].

Consequence: strengthening t27c's middle or its backends buys nothing while the front end can delete nodes. Our instinct that the parser is the dangerous part is the one instinct the literature fully endorses.

### 3. Parser soundness, and what error recovery costs

Settled, with a name. A parser is *sound* when, in the authors' phrase, "the parser accepts only valid inputs"; CompCert's validated parser gets soundness with no hypotheses on the automaton, because its interpreter's only outcomes are `parsed`, `reject` and out-of-fuel [Jourdan, Pottier, Leroy, ESOP 2012, §3, §2.5]. Recovery is exactly what removes that property: it makes acceptance stop implying validity.

Skip-to-synchronisation-token is the worst-studied member of the recovery family and its blast radius is measured. Diekmann and Tratt describe panic mode as "throwing away huge portions of the input", note that popping the parse stack implicitly deletes input from before the error location, and measure 981,628 reported error locations for panic mode against 435,812 for their minimum-cost repair algorithm over 200,000 real syntactically invalid Java programs [Lukas Diekmann, Laurence Tratt, "Don't Panic! Better, Fewer, Syntax Errors for LR Parsers", ECOOP 2020, LIPIcs 166, pp. 6:1–6:32, DOI 10.4230/LIPIcs.ECOOP.2020.6, §1, §3, §6].

The parse-tree-differs-from-the-truth question is not open, and it is older than we assumed. On invalid input there is no true parse; the well-posed surrogate is distance to the nearest string in the language, and that was solved in 1972 by an algorithm that parses any input to completion "finding the fewest possible number of errors" [Alfred V. Aho, Thomas G. Peterson, "A Minimum Distance Error-Correcting Parser for Context-Free Languages", *SIAM Journal on Computing* 1(4):305–312, 1972, DOI 10.1137/0201022 — bibliographic record re-verified this session; full text not read]. What genuinely lacks a bound is panic mode specifically, and Diekmann and Tratt say so in the paper.

Fully verified front ends now exist. CakeML puts its lexer and PEG parser inside the end-to-end theorem, with parser soundness and completeness folded into a theorem about x86-64 machine code, and a lex or parse error is a specified observable output rather than silence [Ramana Kumar, Magnus O. Myreen, Michael Norrish, Scott Owens, "CakeML: a verified implementation of ML", POPL 2014, pp. 179–192, DOI 10.1145/2535838.2535841]. CoStar closes the termination gap Jourdan et al. left open, terminating without error on all inputs including invalid ones [Sam Lasser, Chris Casinghino, Kathleen Fisher, Cody Roux, "CoStar: a verified ALL(*) parser", PLDI 2021, pp. 420–434, DOI 10.1145/3453483.3454053]. Neither specifies recovery: their guarantee on invalid input is that they reject, not that they salvage.

### 4. Silent recovery already has a prescribed policy, and we violated it

This is the most directly actionable settled point, and it removes any claim to novelty in our fact 1. Diekmann and Tratt address the semantic-action question head on in ECOOP 2020 §7: what should semantic actions do when parts of the input have been altered by recovery. They supply the mechanism — repair provenance carried into semantic values so an action can tell user tokens from recovery-inserted ones — and the policy, published in the grmtools documentation for the same tool: run the type checker in the presence of syntax errors but "not generate code", because generated code gives users the illusion their code is safe to run.

The policy predates our measurement. The conjunction we hit — recover, emit, exit 0 — is the one the authors of the algorithm we imitated wrote down as the thing not to do.

### 5. What differential testing can and cannot see

Settled, in three layers, and this is where the literature contradicts our reading of our own strongest evidence.

Differential testing compares implementations and treats divergence as evidence one is wrong [William M. McKeeman, "Differential Testing for Software", *Digital Technical Journal* 10(1):100–107, 1998]. Its power scales with the diversity of what is compared: Csmith's authors found no correlated failures among unrelated C compilers, hypothesised that this is because most compiler bugs live in passes over an intermediate representation and IRs are diverse, and stated the limit plainly — a fault shared by every implementation is undetectable, which they call "an inherent limitation of differential testing without an oracle" [Yang, Chen, Eide, Regehr, PLDI 2011, §2.6].

Independence is weaker than the word suggests even when it is real. Twenty-seven versions written independently from one specification at two universities, subjected to a million tests, failed together substantially more often than independence predicts [John C. Knight, Nancy G. Leveson, "An Experimental Evaluation of the Assumption of Independence in Multiversion Programming", *IEEE TSE* SE-12(1):96–109, 1986, DOI 10.1109/TSE.1986.6312924]; the follow-up fault analysis attributed part of the correlation to programmers making equivalent logical errors on the hard parts [Susan S. Brilliant, John C. Knight, Nancy G. Leveson, "Analysis of Faults in an N-Version Software Experiment", *IEEE TSE* 16(2):238–247, 1990, DOI 10.1109/32.44387].

The shared-component case has a name that predates all of this. Avizienis calls related faults arising from a common link — an ambiguous specification, the same faulty compiler — the most serious limitation of multiple-computation fault tolerance, and already prescribes independently written specifications as the remedy [Algirdas Avizienis, "The N-Version Approach to Fault-Tolerant Software", *IEEE TSE* SE-11(12):1491–1501, 1985].

The compiler-specific instance of our exact architecture is in print. Solidity's legacy and IR pipelines consume the same annotated AST, making the front end a shared component of the differential setup; a miscompilation manifesting identically in both groups goes unnoticed, and the author accepts that blind spot in exchange for an automated oracle [Bhargava Shastry, "Finding and Understanding Miscompilation Bugs in the Solidity Compiler", arXiv:2607.07217, 8 July 2026 — abstract re-verified this session: 25 miscompilation bugs, some unnoticed for multiple years. The 164-internal-error count, the 134-day median persistence and the pre-release interception figures are body-level and I did not read them; single-author preprint, no peer-reviewed venue].

Consequence: our four backends do not check each other's front end, and this was published before we measured it.

### 6. Checkers that take more than the output

Settled, and it is the general form of the repair. A program checker takes the instance the program was run on, not merely its output [Manuel Blum, Sampath Kannan, "Designing Programs That Check Their Work", *Journal of the ACM* 42(1):269–291, 1995, DOI 10.1145/200836.200880; conference version STOC 1989]. The certifying-algorithm line generalises this to the triple (input, output, witness), with strongly certifying algorithms required to identify illegal input as illegal [Ross M. McConnell, Kurt Mehlhorn, Stefan Näher, Pascal Schweitzer, "Certifying algorithms", *Computer Science Review* 5(2):119–161, 2011, DOI 10.1016/j.cosrev.2010.09.009; introduction: Alkassar, Böhme, Mehlhorn, Rizkallah, Schweitzer, *it – Information Technology* 53(6):287–293, 2011]. Note the caveat in the survey itself: some problems admit no strongly certifying algorithm, so the prescribed repair is not universally available.

Translation validation is the per-run instance: validate each individual translation against the source submitted on that run [Amir Pnueli, Michael Siegel, Eli Singerman, "Translation Validation", TACAS 1998, LNCS 1384, pp. 151–166, DOI 10.1007/BFb0054170]. Leroy formalises the payoff, with an explicit hypothesis: a validator *with a proof* that `Validate(S,C) = true ⟹ S ≈ C` can be wrapped into a verified compiler [Leroy, CACM 2009, §2.2]. Without that proof the construction does not confer his conclusion, and he says so.

The generator-front-end version is deployed. EverParse keeps its DSL compiler out of the trusted computing base: rather than being trusted, it emits a formal specification that an independent verifier checks the generated implementation against [Tahina Ramananandro, Antoine Delignat-Lavaud, Cédric Fournet, Nikhil Swamy, Tej Chajed, Nadim Kobeissi, Jonathan Protzenko, "EverParse: Verified Secure Zero-Copy Parsers for Authenticated Message Formats", USENIX Security 2019, pp. 1465–1482].

Jourdan et al. also record why the cheap version is not enough, in a sentence that describes t27c's gate as a *strictly stronger* design than the one they rejected: instrumenting an unverified parser to emit parse trees and re-checking each tree against the grammar at every run does not establish completeness [ESOP 2012, §1]. Their rejected design at least re-checks against the grammar. t27c's gate does not.

### 7. Vacuity: a checker whose verdict did not depend on what it claimed to judge

Settled, in formal verification, since the 1990s. Beatty and Bryant named the propositional case *antecedent failure* — an implication holding trivially because its antecedent is unsatisfiable [Derek L. Beatty, Randal E. Bryant, "Formally Verifying a Microprocessor Using a Simulation Methodology", DAC 1994, pp. 596–602, DOI 10.1145/196244.196575]. Beer, Ben-David, Eisner and Rodeh generalised it to *vacuity* and built detection, on the grounds that "valid formulas can hide real problems in the model"; they report from several years of hardware verification at IBM that on first runs of a new design typically 20% of formulas came back trivially valid and that trivial validity always pointed to a real problem [*Formal Methods in System Design* 18(2):141–163, 2001, DOI 10.1023/A:1008779610539]. That 20% is an experience report, not a controlled measurement, and should be quoted as such.

Kupferman unifies vacuity and coverage under one operation — mutate and see whether the verdict moves [Orna Kupferman, "Sanity Checks in Formal Verification", CONCUR 2006, LNCS 4137, pp. 37–51], building on the mutation-based definition of model-checking coverage [Hana Chockler, Orna Kupferman, Moshe Y. Vardi, "Coverage Metrics for Temporal Logic Model Checking", TACAS 2001, LNCS 2031, pp. 528–542]. Practitioners warn that general vacuity checking is noisy and narrow it to temporal antecedent failure, which in their experience always indicates a real problem [Hana Chockler, Arie Gurfinkel, Ofer Strichman, *Formal Methods in System Design* 46(1), 2015].

The software-testing analogue is *checked coverage*: the backward dynamic slice from a test's oracles as a percentage of coverable statements. Schuler and Zeller's motivating case is a parser test with 83% statement coverage and 0% checked coverage, of which they write that the parser "may return utter garbage, and this test would never notice it" [David Schuler, Andreas Zeller, ICST 2011, pp. 90–99, DOI 10.1109/ICST.2011.32; extended in *STVR* 23:531–551, 2013]. The earlier statement of the same idea is state coverage [Kevin Koster, David Kao, ESEC/FSE 2007 companion, pp. 541–544, DOI 10.1145/1287624.1287705]. The general condition is RIP/RIPR: a fault must be reached, infect state, propagate to output and be revealed by the oracle [Larry J. Morell, "A Theory of Fault-Based Testing", *IEEE TSE* 16(8):844–857, 1990; Nan Li, Jeff Offutt, "Test Oracle Strategies for Model-Based Testing", *IEEE TSE* 43(4):372–395, 2017, DOI 10.1109/TSE.2016.2597136].

The exit-status version is the general error-handling result: 92% of catastrophic failures in five distributed data systems came from incorrect handling of errors the software itself explicitly signalled, and a three-rule static checker would have prevented over 30% of them [Ding Yuan et al., "Simple Testing Can Prevent Most Critical Failures", OSDI 2014, pp. 249–265].

### 8. Oracles for invalid input exist and are measured

This is where our "nobody studies this" instinct fails hardest. TyMut classifies its C++ mutation operators so that well-formed operators produce programs that, in the authors' words, "must be accepted by compilers", while not-well-formed operators produce programs checked against well-formedness rules so that acceptance signals a bug — a definite accept/reject oracle for nearly 80% of generated programs, yielding 102 bugs in GCC and Clang with 56 confirmed new [Bo Wang, Chong Chen, Ming Deng, Junjie Chen, Xing Zhang, Youfang Lin, Dan Hao, Jun Sun, "Fuzzing C++ Compilers via Type-Driven Mutation", *PACMPL* 9(OOPSLA2):1232–1260, 2025, DOI 10.1145/3763094 — bibliographic details and oracle description re-verified this session; full text not read].

Diagnostic-channel testing is likewise established: Epiphron aligns warnings across compilers and treats inconsistencies as defects, finding erroneous, superfluous and missing warnings [Chengnian Sun, Vu Le, Zhendong Su, "Finding and Analyzing Compiler Warning Defects", ICSE 2016, pp. 203–213, DOI 10.1145/2884781.2884879]. Front-end testing by grammar mutation with differential comparison of diagnostics also exists [Haoxin Tu et al., *IEEE Transactions on Reliability* 72(1):343–357, 2022/2023, DOI 10.1109/TR.2022.3171220].

The methodology that produced most of the last fifteen years' compiler bugs did, however, walk away from invalid input. Csmith emits only programs that pass lexing, parsing and type checking, and found 0 of 79 GCC bugs in the front end [Yang et al., PLDI 2011, Table 4, §2.6]. Greybox mutation fuzzing still treats non-compiling programs as low value [Karine Even-Mendoza, Arindam Sharma, Alastair F. Donaldson, Cristian Cadar, "GrayC: Greybox Fuzzing of Compilers and Analysers for C", ISSTA 2023, pp. 1219–1231, DOI 10.1145/3597926.3598130]. McKeeman's 1998 test-quality ladder deliberately included levels below "syntactically correct" and found front-end bugs there. The class is not unstudied; the field's centre of gravity moved off it and has recently moved back.

### 9. Exhaustive enumeration is a named technique, not a gap

Bounded exhaustive testing has a twenty-year record [Kevin Sullivan, Jinlin Yang, David Coppit, Sarfraz Khurshid, Daniel Jackson, ISSTA 2004, pp. 133–142; journal version *IEEE TSE* 31(4):328–339, 2005]. In compiler testing specifically, exhaustiveness relative to a syntactic skeleton is the headline guarantee of skeletal program enumeration, which produced 217 confirmed GCC/Clang bug reports in under six months [Qirun Zhang, Chengnian Sun, Zhendong Su, "Skeletal Program Enumeration for Rigorous Compiler Testing", PLDI 2017, pp. 347–361, DOI 10.1145/3062341.3062379 — re-verified this session]. Symbolic equivalence over all inputs subsumes enumeration [Nuno P. Lopes, Juneyoung Lee, Chung-Kil Hur, Zhengyang Liu, John Regehr, "Alive2: Bounded Translation Validation for LLVM", PLDI 2021, pp. 65–79, DOI 10.1145/3453483.3454030].

Consequence: we may not claim our 2^32 and 256^4 sweeps are unprecedented. We may claim they were run.

### 10. Optimisers delete the things you meant to measure

Settled and quantified. Failing to consume a benchmark result — bad practice "not using a returned computation", whose undesired effect is dead-code elimination — was found prevalent across 123 open-source Java systems, with the Blackhole sink as the standard countermeasure [Diego Costa, Cor-Paul Bezemer, Philipp Leitner, Artur Andrzejak, "What's Wrong with My Benchmark Results? Studying Bad Practices in JMH Benchmarks", *IEEE TSE* 47(7):1452–1467, 2021, DOI 10.1109/TSE.2019.2925345 — bibliographic details re-verified this session]. The in-program analogue, where an optimiser deletes a security check, is optimization-unstable code [Xi Wang, Nickolai Zeldovich, M. Frans Kaashoek, Armando Solar-Lezama, "Towards Optimization-Safe Systems", SOSP 2013, DOI 10.1145/2517349.2522728]. Rust's `black_box` is the same countermeasure.

Consequence: the 225-second rebuild was not a hardening. It was the minimum condition for the number to exist. The 8-second run was never a 55.9-billion-input measurement.

### 11. Spec-first fan-out: what is actually measured

This section corrects a position we held.

The defect-reduction case for generation over transcription is *not* absent from the literature, and it runs in the direction our premise claims. Motorola reports, from more than fifteen years of practice, a 1.2X–4X overall reduction in defects and a 3X improvement in phase containment for model-driven generation against hand-written code, alongside 2X–8X productivity [Paul Baker, Shiou Loh, Frank Weil, "Model-Driven Engineering in a Large Industrial Context — Motorola Case Study", MoDELS 2005, LNCS 3713, pp. 476–491, DOI 10.1007/11557432_36 — re-verified this session]. The transcription side is measured directly: across commercial and open-source systems, inconsistent changes to clones were found, in the authors' words, "very frequent" and a significant number of induced faults were identified [Elmar Juergens, Florian Deissenboeck, Benjamin Hummel, Stefan Wagner, "Do Code Clones Matter?", ICSE 2009, pp. 485–495, DOI 10.1109/ICSE.2009.5070547 — abstract re-verified this session; the frequently cited "107 faults" and "nearly every second inconsistent change" figures are body-level and I did not read them].

What Whittle et al. actually support is the architecture argument, not the defect argument. Their survey of 450 practitioners and 22 interviews across 17 companies reports that "code generation is not the key driver for adopting MDE", productivity from a 27% loss to an 800% gain with most companies at 20–30%, whole-system generation rare, and the named advantage being a forced explicit architecture [Jon Whittle, John Hutchinson, Mark Rouncefield, "The State of Practice in Model-Driven Engineering", *IEEE Software* 31(3):79–85, 2014, DOI 10.1109/MS.2013.65]. That paper measures no defect rates; citing its silence as evidence of absence is a sampling error. Earlier reviews confirm the evidence base was thin [Parastoo Mohagheghi, Vegard Dehlen, "Where Is the Proof? — A Review of Experiences from Applying MDE in Industry", ECMDA-FA 2008, LNCS 5095, pp. 432–443]. The hardware analogue gives roughly a 3X development-time reduction with a persistent quality-of-results gap [Sakari Lahti, Panu Sjövall, Jarno Vanne, Timo D. Hämäläinen, *IEEE TCAD* 38(5):898–911, 2019, DOI 10.1109/TCAD.2018.2834439].

Every single-source multi-target result that carries a *correctness* claim buys it with proof or per-run checking. Halide's schedules are constrained by construction so that they cannot alter what is computed [Jonathan Ragan-Kelley et al., *CACM* 61(1):106–115, 2018, DOI 10.1145/3150211]. Fiat-Crypto machine-checks every lowering step and ships generated code across 80 prime fields and multiple architectures [Andres Erbsen, Jade Philipoom, Jason Gross, Robert Sloan, Adam Chlipala, IEEE S&P 2019, pp. 1202–1219, DOI 10.1109/SP.2019.00005]. Vericert proves HLS in Coq and pays roughly an order of magnitude in output quality [Yann Herklotz, James D. Pollard, Nadesh Ramanathan, John Wickerson, *PACMPL* 5(OOPSLA), Article 117, 2021, DOI 10.1145/3485494].

Unproven lowering tools misbehave exactly as expected. All four production HLS tools tested could be made to crash or emit wrong hardware from valid C [Yann Herklotz, Zewei Du, Nadesh Ramanathan, John Wickerson, FCCM 2021, pp. 219–223, DOI 10.1109/FCCM51124.2021.00034], and FPGA synthesis below them introduces netlist-versus-design discrepancies [Yann Herklotz, John Wickerson, FPGA 2020, pp. 277–287, DOI 10.1145/3373087.3375310]. Structural fuzzing of a shared multi-target IR does not find silent bugs; you must lower to executable form and compare [Chenyao Suo, Jianrong Wang, Yongjia Wang, Jiajun Jiang, Qingchao Shen, Junjie Chen, "DESIL: Detecting Silent Bugs in MLIR Compiler Infrastructure", *PACMPL* 9(OOPSLA2), Article 383, 2025, DOI 10.1145/3763161, arXiv:2504.01379 — 23 silent and 19 crash bugs, re-verified this session]. MLIR's own authors name traceability as a design principle and state that reproducing translation validation remains an open problem for extensible lowering ecosystems [Chris Lattner et al., "MLIR: Scaling Compiler Infrastructure for Domain Specific Computation", CGO 2021, pp. 2–14, DOI 10.1109/CGO51591.2021.9370308].

### 12. Where the literature contradicts us, stated plainly

1. **Silence is not the majority failure mode, and the ratio is a property of the oracle.** Csmith: 95 wrong-code against 186 crash bugs across GCC and LLVM, 34% silent [Yang et al., PLDI 2011, Tables 5–6]. EMI on the same two compilers: 95 wrong-code against 33 crash, 65% silent, because its oracle is transformation invariance rather than cross-implementation agreement [Le, Afshari, Su, PLDI 2014, Table 2]. A project sees the failure class its oracle is shaped to see. Our six facts describe our gates at least as much as they describe t27c.

2. **Miscompilation in a mature compiler may matter less than we assume.** Compiling over 10 million lines from 309 Debian packages under historical Clang/LLVM miscompilation bugs, almost half propagated into some binary but typically corrupted a very small part of it and produced two test-suite failures in total; human-reported and verification-found bugs did no worse [Michael Marcozzi, Qiyi Tang, Alastair F. Donaldson, Cristian Cadar, "Compiler Fuzzing: How Much Does It Matter?", *PACMPL* 3(OOPSLA), Article 155, 2019, DOI 10.1145/3360581]. Two limits: their impact oracle is the downstream package's own test suite, and their subject has a huge regression suite and millions of users. t27c has neither, and deleting nine of 21 functions is not a subtle codegen divergence. But we may not cite silent miscompilation as an existential risk without citing this too.

3. **"Silent bugs live for years" is a tail claim, not a typical one.** GCC regression bugs: median time-to-reveal 20 days, mean 163, max 3,492 [Chengnian Sun, Vu Le, Qirun Zhang, Zhendong Su, "Toward Understanding Compiler Bugs in GCC and LLVM", ISSTA 2016, pp. 294–305, DOI 10.1145/2931037.2931074].

4. **Raising coverage or adopting a mutation score would not have helped.** Coverage correlates only weakly-to-moderately with effectiveness once suite size is controlled, and stronger criteria are no better than statement coverage [Laura Inozemtseva, Reid Holmes, ICSE 2014, pp. 435–445]. Mutation-score/real-fault correlations are also weak once size is controlled [Mike Papadakis, Donghwan Shin, Shin Yoo, Doo-Hwan Bae, ICSE 2018, pp. 537–548]. Even the favourable study leaves 17% of real faults uncoupled to any mutant [René Just, Darioush Jalali, Laura Inozemtseva, Michael D. Ernst, Reid Holmes, Gordon Fraser, FSE 2014, pp. 654–665]. And every standard operator mutates the program under test, never the `.t27` input where our fault lives. The relevant technique — mutating a specification — exists but is aimed at generating tests rather than at checking that a compiler's gates fire [Paul E. Black, Vadim Okun, Yaacov Yesha, ASE 2000, pp. 81–88].

5. **Our fact 3 has no name in the testing literature.** It has names next door: vacuity/antecedent failure in model checking, the `f1 ≠ f2` independence conjunct in the pseudo-oracle formalism [Earl T. Barr, Mark Harman, Phil McMinn, Muzammil Shahbaz, Shin Yoo, "The Oracle Problem in Software Testing: A Survey", *IEEE TSE* 41(5):507–525, 2015, DOI 10.1109/TSE.2014.2372785, §5.1], and trusted computing base. Anyone claiming a testing-literature name for it is inventing one.

6. **"Trusting trust" is the wrong analogy.** Thompson's compiler reproduces its defect deliberately and hides it from source inspection [Ken Thompson, "Reflections on Trusting Trust", *CACM* 27(8):761–763, 1984, DOI 10.1145/358198.358210]. Ours loses statements by accident and the loss is visible in the source the moment you count. What transfers is only the structural remedy — diversity in the checking path — which Wheeler proves rather than asserts, and whose residue he names: two compilers failing the same way are not detected [David A. Wheeler, "Fully Countering Trusting Trust through Diverse Double-Compiling", PhD dissertation, George Mason University, 2009, arXiv:1004.5534, §4.7].

---

## Propositions

Six propositions went into refutation. Four survive, all demoted from THEOREM or CONJECTURE to OBSERVATION. Two were withdrawn. Both withdrawals are recorded.

---

### P1 — OBSERVATION (demoted from THEOREM): the lowerability gate reads only what the parser produced

**Statement.** `Compiler::is_icarus_lowerable` (`/Users/playra/t27/bootstrap/src/compiler.rs:10665`) computes `parse_ast(source)?` and then classifies only the resulting AST. `parse_fn_body` (line 1887) discards a failed statement via `Err(_) => self.recover_to_stmt_boundary()`, pushing nothing into `decl.children`; recovery (line 1901) skips to the next `;` at brace depth 0 or stops at the enclosing `}`. `match` has no token kind, node kind or parse rule anywhere in `compiler.rs`, so a function body consisting of a `match` is consumed in full and the `FnDecl` is left with zero children. `ast_is_icarus_lowerable` (line 10735) iterates `FnDecl` children and returns `Ok(true)` on the empty loop. A spec containing `match` is therefore reported lowerable, and the gate cannot separate "the body was empty in the source" from "the body was emptied by recovery".

**Evidence.** Fact 3 from the 2026-08-23 campaign. Line references re-read this session: `parse_fn_body` at 1887 ends `Ok(())` unconditionally, so *no* parse error inside any function body ever reaches a caller; `grep -c` for `TokenKind::Match|NodeKind::Match|parse_match` returns 0.

**Two clauses of the original are struck.** (i) Not "zero information about parse fidelity": `parse_ast` (line 10605) propagates every error recovery does not swallow, so malformed top-level items surface through the gate as `Err`. The blindness is confined to statement-level losses inside function bodies. (ii) Not "the defect is the gate's arity, not its reasoning": the loss *is* recorded in the artifact the gate already reads — an `FnDecl` with zero children — and `compiler.rs:7440` already branches on exactly that, emitting `// TODO: implement`. A classifier that refused a declared function with an empty body would have caught the `match` regression with no new input.

**Prior work.** The design was rejected in print in 2012: instrumenting a parser to emit trees and re-checking each against the grammar does not establish completeness [Jourdan, Pottier, Leroy, ESOP 2012, §1] — and that rejected design is stronger than ours, since it at least re-checks against the grammar. Leroy identifies the underlying circularity for parsers specifically [CACM 2009, §3.2]. The repair shape is Blum and Kannan [JACM 1995] and the certifying-algorithm line [McConnell et al., 2011]. The phenomenon shape is vacuity [Beer et al., FMSD 2001; Beatty and Bryant, DAC 1994], though vacuity is a property of the formula while this is a property of the model handed to the checker.

**Also known in-repo.** `compiler.rs:25093` states that recovery "makes parser rejections silent", and the surrounding module exists to convert that silence into a checked contract. The behaviour was annotated before it was rediscovered.

**Scope.** One gate, one compiler, one construct. The general form — a gate cannot detect a loss the producing stage did not record in the artifact the gate reads — is true by the meaning of "did not record" and is not ours to name.

**Why demoted.** The original argued `G = g ∘ P` is a function, hence `P(s1) = P(s2) ⟹ G(s1) = G(s2)`. That is the definition of a function, not a theorem. Its scope clause ("stops holding once the stage records its losses") contradicted its universal statement, and failed on its own flagship case, because t27c *does* record the loss as an empty child list.

---

### P2 — OBSERVATION (demoted from THEOREM): the four backends cannot cross-check the front end

**Statement.** In t27 a single parse produces one `Node`, and the backends are invoked on it (`main.rs:4091–4106`: `match backend { "verilog" => cg.gen_verilog(&ast), "c" => cg.gen_c(&ast), _ => cg.gen_zig(&ast) }`). The tuple of backend outputs is a function of the AST alone: two sources that parse to the same AST yield byte-identical output from every backend, so no comparison among them can tell those sources apart. Cross-backend agreement is evidence about the four lowerings and no evidence about whether the AST faithfully represents the `.t27` text.

The operative property is **invariance under the parse**, not agreement. The backends are different functions of the same AST and do not generally agree — the Verilog lowering carries `detect_unsupported_verilog_locals` and several "not yet lowered to Verilog" degradations for constructs the other backends accept — and the differential campaign depends on their being able to disagree. A fifth backend that also factors through this AST adds no checking power over the front end. A second, independently written reader of the `.t27` text would add checking power over the front end, but not all of it.

**Evidence.** Facts 1 and 2: nine of 21 declared functions absent from all four outputs identically, the loss preceding the fork. Dispatch structure re-read this session.

**Prior work.** The general form is Avizienis's related-fault limitation of multi-version comparison [*IEEE TSE* SE-11(12):1491–1501, 1985], and the compiler-specific instance is already published for Solidity [Shastry, arXiv:2607.07217, 2026]. Csmith's authors attribute the *absence* of correlated compiler failures to IR diversity and state the no-oracle limit directly [Yang et al., PLDI 2011, §2.6]. A survey catalogues our exact arrangement as the cross-optimization strategy and calls it the most widely used in compiler testing [Junjie Chen, Jibesh Patra, Michael Pradel, Yingfei Xiong, Hongyu Zhang, Dan Hao, Lu Zhang, "A Survey of Compiler Testing", *ACM Computing Surveys* 53(1), Article 4, 2020, DOI 10.1145/3363562]. The contribution is the measurement that t27 has this shape, not the principle.

**Scope.** Holds for any consumer that factors through the same `Node`. It does *not* license "one independent reader adds all of it": Knight and Leveson [1986], Brilliant et al. [1990] and Wheeler's DDC residue [2009, §4.7] all say a second reader written by the same author from the same `.t27` specification leaves correlated failure. Nor does it license "cross-backend comparison retains full power downstream": the four lowerings live in one 29,252-line file, share the `Node` type and helper code, and were written by one author in one idiom, so downstream power is real but unquantified.

**Why demoted.** The stated "theorem" was a tautology and, as written, false: it claimed all backends agree on AST-determined properties, which is contradicted in this codebase by the Verilog degradations, and contradicted by the proposition's own scope, which requires the backends to be able to disagree.

---

### P3 — WITHDRAWN: "recovery turned a parse failure into a faithful compile of a smaller program"

**What survives as a bug report.** On one brace-unbalanced `.t27` spec, t27c's hand-written recursive-descent front end recovered rather than rejected, returned a semantic value, exited 0 with empty stderr, and the backends lowered a smaller program than the one submitted. The recovery is statement-level skip-to-synchronisation-token (`compiler.rs:1901`), a family whose discarded region is not bounded by the algorithm [Diekmann and Tratt, ECOOP 2020, §3]. That is a defect worth filing against t27c.

**Why withdrawn as a proposition.** Two load-bearing general claims were false, and the scope condition fenced only the measurement, not the claims.

- "The compiler-testing literature measures neither [accepts-invalid nor how much is lost]." False at three levels simultaneously: TyMut builds a definite accept/reject oracle covering nearly 80% of generated programs [Wang et al., OOPSLA 2025]; Diekmann and Tratt measure recovery outcomes over 200,000 invalid programs; and t27c's own `mod tests_compiler_rejects` (`compiler.rs:~25089`) already pins the behaviour with roughly twenty negative tests, including `rejects_unclosed_paren` and `rejects_unterminated_module`.
- "No theorem bounds how a recovered parse tree may differ from the true parse." Ill-posed — on invalid input there is no true parse — and the well-posed surrogate is Aho and Peterson [SIAM J. Comput. 1972].

Additionally, the policy we proposed as the remedy is printed in the documentation of the tool from the paper we cited: run the type checker on syntactically broken input but "not generate code". The mechanism is also supplied there — repair provenance carried into semantic values [Diekmann and Tratt, ECOOP 2020, §7.2].

**Open item left behind.** `rejects_unterminated_module` asserts that at least one brace-imbalance shape produces a hard error, so the observed exit-0 case is either a distinct shape the module parser swallows or a regression against an existing contract. Unresolved.

---

### P4 — OBSERVATION (demoted): three gates whose verdict did not depend on what they judged

**Statement.** Facts 3, 4 and 5 share one observable property: the gate's reported verdict was invariant under the value the gate claimed to judge. The classifier's verdict did not vary with the deleted `match`. The typecheck consumer's verdict did not vary with the N errors printed. The differential harness's first PASS did not vary with the compared computations, because the optimiser had deleted them.

This is a shared property, not a single defect. Facts 3 and 4 are values computed but not checked; fact 5 is a value never computed at all — in RIP/RIPR terms two propagation/revealability failures and one reachability failure.

**Evidence for fact 4, re-read this session.** `main.rs:4628` prints `Typecheck FAILED ({} errors, {} warnings):`, iterates the messages, and falls through to `Ok(())`. Exit status 0. One precision the original missed: the *codegen* path does fail closed — `main.rs:4088` does `anyhow::bail!("Typecheck failed with {} errors", ...)` before dispatching to a backend. The fail-open is in the standalone `typecheck` subcommand used as a gate, not in the compile path.

**Evidence for fact 3.** `parse_fn_body` (`compiler.rs:1887`) ends `Ok(())` unconditionally: no parse error inside any function body can reach a caller. That is a stronger statement of the same defect than "the `Err(_)` payload is dropped", since the `Ok`/`Err` discriminant *does* influence control flow into `recover_to_stmt_boundary`.

**What may not be said.** No checked-coverage figure may be quoted for any of the three. Checked coverage is a percentage of all coverable statements lying on a backward dynamic slice from a check; it requires running a slicer; no slicer was run; and its zero case is a test with no oracle at all, which none of these is [Schuler and Zeller, ICST 2011 / *STVR* 2013, §2.2]. A source-level slicer would in any case be blind to fact 5, where the deletion happens below the IR.

**Prior work.** Antecedent failure [Beatty and Bryant, DAC 1994]; vacuity [Beer et al., FMSD 2001]; state coverage [Koster and Kao, ESEC/FSE 2007]; checked coverage [Schuler and Zeller, ICST 2011]; RIP/RIPR [Morell, *IEEE TSE* 1990; Li and Offutt, *IEEE TSE* 2017]; explicitly-signalled-then-ignored errors [Yuan et al., OSDI 2014]; optimiser-deleted checks [Wang et al., SOSP 2013]; dead-code-eliminated benchmark bodies [Costa et al., *IEEE TSE* 2021]. Every piece is named. What is ours is three instances in one build system on one day.

**Untested prediction.** Perturbing each gate's input and requiring the verdict to change — Kupferman's mutate-and-see-whether-the-verdict-moves test [CONCUR 2006] — would expose more. Until that is run, the miss rate of every gate in this tree is unmeasured.

**Why demoted.** The unifying sentence is a restatement of a decades-old concept, so it earns no credit as a finding; and the original asserted a specific value of a specific published metric that nobody computed and that cannot be zero for these cases.

---

### P5 — OBSERVATION (demoted): 55.9 billion inputs measured volume, not independence, and excluded the defect

**Statement.** The 55.9-billion-input campaign measured volume over a region that, in this artifact, did not contain fact 1's defect. The nine functions deleted in fact 2 were absent from both the code under test and the reference, so no input count could have surfaced them.

**Prior work — this is an instance, not a discovery.** Omission errors survive execution of all control-flow paths; "missing control-flow paths" is the first class in the 1975 fault taxonomy [John B. Goodenough, Susan L. Gerhart, "Toward a Theory of Test Data Selection", *IEEE TSE* SE-1(2):156–173, 1975 — bibliographic details and the fault class re-verified this session]. The differential-testing form is stated in the paper we cite: a fault shared by every implementation is undetectable, which the authors call "an inherent limitation of differential testing without an oracle" [Yang et al., PLDI 2011, §2.6]. A shared omission is exactly that shared fault.

**Separately, and explicitly not measured.** The reference was transcribed by the same team from the same `.t27` spec, so the agreement figure carries no evidence about fidelity to intent. Knight and Leveson makes the same-team case a worse prior, not a measured result [*IEEE TSE* 1986]; and Brilliant et al. attribute the correlation to problem difficulty and hard regions of the input space rather than to shared misreading of a specification [*IEEE TSE* 1990], so even the analogy transfers less cleanly than "two readings of one document" suggests.

**Three claims withdrawn.**

1. That Barr et al. classify what we built as a pseudo-oracle. Their definition is independence-constitutive — an alternative version produced independently, e.g. by a different team or in a different language [*IEEE TSE* 41(5), 2015, §5.1]. A same-team transcription fails the constitutive criterion. The survey also never cites Knight and Leveson, so it cannot be invoked to frame the independence critique.
2. That exhaustive-domain differential execution has no counterpart in the literature. It has several: bounded exhaustive testing [Sullivan et al., ISSTA 2004], skeletal program enumeration [Zhang, Sun, Su, PLDI 2017], exhaustive binary32 sweeps against a reference in CORE-MATH [Alexei Sibidanov, Paul Zimmermann, Stéphane Glondu, ARITH 2022, pp. 26–34], and symbolic all-input equivalence [Lopes et al., PLDI 2021].
3. That we are "ahead on the oracle axis" of the PLDI 2011 setup. Csmith traded ground truth for genuinely independent implementations; we traded independent implementations for one same-team transcription.

**Scale note.** 55.9e9 is about 13 complete 2^32 sweeps, and 256^4 *is* 2^32 — the two "complete domains" are one cardinality named twice.

**Why demoted.** The measured half is an observation; the independence half was never measured and was bundled under the same label.

---

### P6 — WITHDRAWN: "spec-first fan-out is unproven as a defect argument"

**What survives.** t27 has never measured the defect effect of spec-first fan-out. The counterfactual — four hand transcriptions of `trust_manager.t27` — was never run, and fact 6 records that the divergence which did occur was caught by a cross-artifact count, not by inter-backend comparison. No defect claim about the architecture is earned *locally*.

**Why withdrawn as stated.** The proposition asserted the defect argument was "unsupported by evidence — ours or anyone's". The universal is false, and the literature that does measure it leans in the direction our premise claims: Motorola's 1.2X–4X defect reduction and 3X phase containment for generated against hand-written code [Baker, Loh, Weil, MoDELS 2005], and the measured fault yield of inconsistent changes to duplicated code [Juergens et al., ICSE 2009] — which is precisely the mechanism of writing one rule four times and updating three. Reasoning from "the largest survey of MDE adoption practice does not measure defects" [Whittle et al., 2014] to "nobody has" is a sampling error: that paper never sets out to measure them.

The second half — that a fault upstream of the fan-out yields no signal under inter-backend comparison — is not a conjecture either. It is near-definitional and independently published [Avizienis 1985; Shastry 2026].

**One residue worth keeping.** Our own scope conceded that facts 1–2 support the consistency argument "backhandedly, since all four backends stayed consistent with each other even while all four were wrong". That concession undermines the retreat position: consistency-by-shared-derivation is not obviously a benefit in the failure case; it is the symptom.

---

## What this means for T27

### On trusting a parser you cannot verify

Do not trust it, and do not plan to verify it soon. Two facts govern this. First, in the most heavily verified C compiler in existence, the path from source text to the first artifact any downstream checker inspects is still unverified, and that is where the surviving bugs were found [Monniaux and Boulmé, ESOP 2022; Yang et al., PLDI 2011, §3.1]. Second, the `.t27` grammar is small enough that a fully verified front end is now off-the-shelf-reachable in a way it was not when CompCert made its trust decisions [Lasser et al., PLDI 2021; Kumar et al., POPL 2014]. Those two facts point the same way: name the TCB explicitly, and stop letting anything inside it certify itself.

Concretely, three changes follow, in cost order.

1. **Stop recovering-and-emitting.** The conjunction "recover AND emit AND exit 0" is the one the recovery literature's own authors prescribe against [Diekmann and Tratt, ECOOP 2020 §7 and the grmtools documentation]. The minimum change is to carry repair provenance out of `parse_fn_body` — which today returns `Ok(())` unconditionally (`compiler.rs:1887`) and discards every `Err` payload at six sites — and to gate codegen on "no repair applied". This is cheaper than any gate we could build downstream and it fixes facts 1 and 2 at their source.
2. **Make refusal free.** Leroy's framework says a compiler that refuses more often is still verified; success rate is a testing concern, not a correctness concern [CACM 2009, §2.2]. So `t27c typecheck` printing FAILED and returning 0 (`main.rs:4628`) costs us nothing to fix. Note the compile path already fails closed (`main.rs:4088`); only the standalone gate is fail-open. Put validation at build time where the precedent puts it: on failure, abort the build of the tool, not a run of it [Jourdan et al., ESOP 2012, §5].
3. **If a front-end oracle is wanted, it must not read the parser's output.** The deployed pattern is EverParse's: keep the untrusted generator out of the TCB by having it emit a specification an independent checker validates against [Ramananandro et al., USENIX Security 2019]. The cheap version for us is a checker whose inputs are the `.t27` text and the emitted artifact, with a witness in between — declared symbol list, brace-balance ledger, consumed source spans.

### On gates that read the compiler's own output

The general rule is settled and it is about the checker's arity, with one important local exception.

The rule: a checker takes the instance the program was run on, not merely its output [Blum and Kannan, JACM 1995], ideally with a witness [McConnell et al., 2011]. Our lowerability gate is a predicate on the parser's AST alone, which is the design Jourdan et al. rejected in 2012 — and ours is weaker than the one they rejected, since it does not even re-check against the grammar.

The exception, which matters because it is cheaper than the rule: in this specific case the loss *was* recorded in the artifact the gate already read. An `FnDecl` with zero children is the record, and `compiler.rs:7440` already branches on it to emit `// TODO: implement`. A classifier that refused a declared function with an empty body would have caught the `match` regression with no new input. So the immediate action is not "rebuild the gate with two arguments"; it is "make the existing gate refuse the state it already sees", and then add the two-argument validator for the losses that leave no such trace.

Two disciplines follow for every gate in the tree, both cheap and both drawn from other fields.

- **Every gate must have a negative test.** Feed it a deliberately broken input and require a non-zero exit. This is the LAVA discipline — a tool whose miss rate has never been measured has no known miss rate [Brendan Dolan-Gavitt et al., IEEE S&P 2016, pp. 110–121] — and the Aspirator discipline of flagging handlers that swallow an explicitly signalled error [Yuan et al., OSDI 2014].
- **Every passing gate must be shown to depend on what it judged.** Perturb the input, require the verdict to move [Kupferman, CONCUR 2006; Chockler, Kupferman, Vardi, TACAS 2001]. Keep it narrow — a dependency check ("the verdict was computed from zero nodes of the kind claimed") rather than a general vacuity checker, which practitioners report is noisy and gets muted [Chockler, Gurfinkel, Strichman, FMSD 2015].

The prior on how many of our gates are affected should be high, not low. IBM's experience report on fresh property suites is roughly 20% trivially valid on first runs [Beer et al., FMSD 2001]. We found three in one day without looking systematically.

### Which verification techniques earned their cost here

**Earned it.**

- *Counting declarations in the spec against declarations in the generated code.* It fired on the production corpus where reading and target-only inspection had not. It is cheap enough to run on every build, unlike the 225-second differential run. It is a derived/partial oracle in the standard taxonomy [Barr et al., *IEEE TSE* 2015] and a per-run validator in shape [Pnueli, Siegel, Singerman, TACAS 1998]. Note carefully what actually distinguished it: corpus-wide automatic application to real specs, not two-argument-ness. Two-argument checks already existed in `mod tests_compiler_rejects` and saw nothing, because they ran on hand-written fixtures.
- *Differential execution against a transcribed reference, with `black_box`.* It caught real defects in the backends. That is what it is evidence about.
- *Exhaustive enumeration where the domain permitted it.* All 2^32 single-`u32` inputs, all 256^4 four-byte-packer tuples. This is a named technique with precedent [Sullivan et al., ISSTA 2004; Zhang, Sun, Su, PLDI 2017; Sibidanov, Zimmermann, Glondu, ARITH 2022], and where a function's domain is exhaustible, coverage percentages and mutation scores are the wrong instruments and should not be reported for it.

**Did not earn it.**

- *The self-consuming lowerability gate.* Rejected in the literature in 2012, and refuted on its own flagship case.
- *Exit-status-only gate consumption.* The null oracle strategy, empirically the weakest [Barr et al., §6; Li and Offutt, *IEEE TSE* 2017].

**Not worth buying next.**

- *A general random fuzzer for t27c.* Random generation of well-formed programs found 0 of 79 GCC front-end bugs [Yang et al., PLDI 2011, Table 4], is biased toward crashes rather than the silent class [Le et al., PLDI 2014], and the impact study argues against alarm about miscompilation volume in general [Marcozzi et al., OOPSLA 2019]. The measured payoff in this literature comes from targeted differential execution and from making the compiler's output checkable.
- *A fifth backend.* It adds no checking power over the front end, by the structure of the dispatch.
- *A coverage or mutation-score target.* Both are weakly predictive once suite size is controlled [Inozemtseva and Holmes, ICSE 2014; Papadakis et al., ICSE 2018], and every standard mutation operator mutates the program under test rather than the `.t27` input where our fault lives.

**Worth buying, in order.** (1) Repair provenance plus refuse-to-emit. (2) Non-zero exits and a negative test per gate. (3) A mutation operator set over `.t27` specs — unbalanced brace, unsupported construct, deleted statement — used to check that our gates fire, which is the one use the specification-mutation literature does not occupy [cf. Black, Okun, Yesha, ASE 2000]. (4) An independent reader of `.t27` text, understanding it buys real but partial front-end coverage. (5) Three to six structurally *different* conservation relations rather than one, since a single necessary property is not sufficient and count-preserving corruptions are exactly what statement-level recovery produces [Tsong Yueh Chen, Fei-Ching Kuo, Huai Liu, Pak-Lok Poon, Dave Towey, T. H. Tse, Zhi Quan Zhou, "Metamorphic Testing: A Review of Challenges and Opportunities", *ACM Computing Surveys* 51(1), Article 4, 2018, DOI 10.1145/3143561].

**One target with no oracle at all.** Verilog. Simulation-versus-synthesis-versus-silicon is a different problem with its own unreliable stage below us [Herklotz and Wickerson, FPGA 2020], and the published design for an out-of-family oracle there is the HLS-study pattern: compile the same source both to hardware and to an executable and compare [Herklotz, Du, Ramanathan, Wickerson, FCCM 2021]. We do not have that. Note also that `on_clock`/`on_comb` lower to `always` blocks rather than Verilog `function`s (`compiler.rs:6203`, `6224`, `6402`), so declared t27 `fn`s do not map one-to-one to emitted Verilog functions and the declared-versus-emitted count needs a Verilog-specific definition before it means anything there.

---

## What we have not established

Exhaustively. This section is the load-bearing part of the document.

**On the measurements themselves.**

1. We measured one compiler on one day, 2026-08-23. Nothing here has been reproduced by anyone else, inside or outside this project.
2. Fact 2's amplification — one surplus brace, nine of 21 declared functions lost — is a single data point. There is no published distribution of statements-or-functions lost per syntax error under panic-mode recovery to compare it against, so we cannot say whether 9/21 is typical or extreme. The recovery literature counts spurious error *messages*; the fuzzing literature counts *bugs*. Neither counts lost output.
3. The differential work covered a handful of functions with small domains, not the corpus. It is evidence about those functions in those backends, and about nothing else.
4. We have not measured how many `.t27` specs in the corpus currently lose statements to recovery. We know the mechanism and we know one instance.
5. We have not measured the miss rate of any gate in the tree. Three vacuous passes were found without a systematic search; the base rate is unknown.
6. We have not run the perturbation test (mutate the gate's input, require the verdict to move) on any gate.
7. The `rejects_unterminated_module` test asserts that at least one brace-imbalance shape produces a hard error. Whether the observed exit-0 case is a different shape or a regression against that contract is unresolved.
8. We have not established that fixing the front end would have changed any shipped artifact's behaviour. Marcozzi et al. [OOPSLA 2019] is a standing reason to doubt that miscompilation in general has large downstream effect; their subject is a mature compiler and ours is not, but we have measured nothing on our side.

**On what our evidence cannot in principle support.**

9. The 55.9-billion-input agreement bounds implementation divergence between the generated Rust and one same-team transcription. It says nothing about fidelity to intent, and by construction it could not have surfaced the deleted functions.
10. We have not tested whether our transcriber and our parser correlate in their misreadings of the `.t27` spec. Knight and Leveson makes that a worse prior; it is not a measurement.
11. Cross-backend agreement is not evidence about the front end. It never was, and we should stop citing it as corroboration.
12. We have no oracle for the Verilog backend.

**On the literature.**

13. Nothing here is a novel result. Every mechanism, policy and remedy in this document is prior work; four of them are in the papers our own surveys cited. The contribution is a set of measurements of one system.
14. Several body-level figures are inherited rather than re-verified by me: the Solidity preprint's 164 internal errors, 134-day median persistence and pre-release interception split (abstract confirms 25 miscompilation bugs, some hidden for multiple years); the Juergens et al. "107 faults" and "nearly every second inconsistent change" figures (abstract confirms only that inconsistent changes are "very frequent" and induce a significant number of faults); Aho and Peterson's full text; TyMut's full text.
15. Citations re-verified against primary or authoritative sources in this session: Shastry (arXiv:2607.07217); DESIL (arXiv:2504.01379); Baker, Loh and Weil (MoDELS 2005 defect and productivity figures); Juergens et al. (ICSE 2009 abstract); Aho and Peterson (SIAM J. Comput. 1(4):305–312, 1972, DOI 10.1137/0201022); Zhang, Sun and Su (PLDI 2017); Wang et al. (*PACMPL* 9(OOPSLA2):1232–1260, 2025, DOI 10.1145/3763094); Costa et al. (*IEEE TSE* 47(7):1452–1467, 2021). Everything else is inherited from the survey strands, which recorded reading primary PDFs.
16. Local code claims re-read in this session, read-only: `compiler.rs` line count 29,252; `parse_fn_body` at 1887 with `Err(_) => recover_to_stmt_boundary()` at 1893 and unconditional `Ok(())`; five further `Err(_) => recover_to_stmt_boundary()` sites at 2168, 2200, 2229, 2295, 2323; `recover_to_stmt_boundary` at 1901 skipping to `;` at brace depth 0 or stopping at `}`; `parse_ast` at 10605; `is_icarus_lowerable` at 10665 and `ast_is_icarus_lowerable` at 10735; zero occurrences of `TokenKind::Match`, `NodeKind::Match` or `parse_match`; `// TODO: implement` emitted on `node.children.is_empty()` at 7440; the recovery-is-silent doc comment at 25093; `Typecheck FAILED` printed at `main.rs:4628` followed by `Ok(())`; backend dispatch on one `ast` at `main.rs:4091–4106` with a preceding `anyhow::bail!` on type errors at 4088.
17. Not re-verified locally: the `tests_compiler_rejects` test bodies beyond their names and doc comment; the Verilog degradation paths; the `on_clock`/`on_comb` line references; the `detect_unsupported_verilog_locals` behaviour.

**On the framing.**

18. Our six facts describe the shape of our oracles at least as much as they describe t27c. EMI and Csmith saw opposite silent/loud ratios in the same two compilers because their oracles differed [Le et al., PLDI 2014, Table 2; Yang et al., PLDI 2011, Tables 5–6]. We have not run a second, differently shaped oracle over t27c, so we cannot separate the two readings.
19. We have not established that the defect class we found is more consequential than the ones our gates are shaped to see. We have established that it is the one our gates could not see.