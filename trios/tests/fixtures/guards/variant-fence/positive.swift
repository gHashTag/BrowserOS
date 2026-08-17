// The positive arm of `make variant-fence`.
//
// Compiled together with the two sources that declare the variant vocabulary
// (rings/SR-00/BuildVariantPolicy.swift and BR-OUTPUT/ProjectPaths.swift).
// It must typecheck.
//
// It is here so the negative witnesses beside it cannot pass by accident.
// Every one of those asserts "this does NOT compile", and the cheapest way to
// satisfy all of them at once is for the symbols to stop existing - delete the
// enum, rename ProjectPaths.variant, change areFullyIsolated's arity, and all
// three go red for reasons that have nothing to do with the fence. This file
// names each symbol at the type the fence depends on, so that failure mode is
// a failing check rather than a passing one.
//
// It is also the arm a mutation trips: a raw string written back into the real
// source where a BuildVariant belongs breaks THIS compile, in the real file,
// with the real diagnostic.

enum VariantFenceWitness {
    static func witness() {
        // The variant is a value of an enum type, not a string.
        let _: BuildVariant = ProjectPaths.variant

        // The dev/release fork is a comparison between two BuildVariants.
        let _: Bool = ProjectPaths.isDevVariant
        let _: Bool = (ProjectPaths.variant == .dev)

        // The two constants the hunt found written a second time elsewhere:
        // the runtime data root (.trinity / .trinity-dev) and the MCP port
        // (9105 / 9205). Both are reached by asking a BuildVariant.
        let _: String = BuildVariant.dev.dataDirectoryName
        let _: String = BuildVariant.prod.mcpPort

        // And an API that takes variants takes them as variants.
        let _: Bool = BuildVariantPolicy.areFullyIsolated(.dev, .prod)
    }
}
