/**
 * sha256 of every file a release shipped under the CLI-owned skill trees, by
 * skill and path relative to the skill directory, whole file. The deploy
 * repaired frontmatter from 0.16.1 on, but every SKILL.md those releases
 * shipped was already complete, so what is on disk is what was shipped.
 *
 * Generated from `git ls-tree -r <ref> -- skills/` over all 100 tags
 * through v0.25.0 plus origin/main before the stub (installs from `main`),
 * minus `teamai-wiki` (see PACKAGED_SKILL_FILES). Do not edit by hand; a new
 * release adds nothing here, since the package no longer ships these trees.
 */
export const PACKAGED_SKILL_DIGESTS: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map([
  ['teamai', new Map([
    ['SKILL.md', ['82a22b1c37531834ab5784f93f950f0a8840ac4e4aa422f1ef2dc03437f9ad66', '898fc8a74fec0ccba37b0a6c7a8a446d3dde97a486fc566340f80c259faf4211', 'a523cfc79aca5870f6f35ff639229777f4f506457666560ec21f57176cf7f78e']],
    ['references/contribute-member.md', ['2a6a8c3eeee7424f79cb6d3f97d14f8588720f1d570028f5afdd12d6db458355']],
    ['references/join-member.md', ['2f2f823675cea971b2a0360e7c6f090b2397e25702e60cce50bafb2b450ce8c3', '45e56c965fba5fe5f14cfb927c9b18032d19ebf98e524e7c709bcde16862b15a', '9584d1f228930c01141dc47a19623c17b02df999b0bff19e104d1a18fc952fcb', 'ed2ab1c92680b3412e2ce60d5900f6baba0da896ad92158945ac6115ac939fc2']],
    ['references/manage-admin.md', ['fd31d78724fb35d3bfecf606299c9e907f2a10da275bf06f840780c674584158']],
    ['references/provider-tgit.md', ['386a14715db132b5b34ab95a7586119b79a6795cbbbe776a4be455b1af7fa49f', 'df7faedb8beeafeb55a23c2b3d2b99d1421548cf4f8172ed7da0752ef6aeda39']],
    ['references/setup-admin.md', ['4e58bae91bcb3831fd7d2dc0c9f086bb0e985f7d51dd7bc7e753bce1b380816e', '615fc60bab798125bc2b6340e87b3a1e5376b7d499cab5d884f9d78bab07154b', 'dae12585f3003f1e6c347f51859de68c7af9baf11b84be63559cb782d122db7b', 'ff9996686f42cc7d7c2a09cb5f254dc0d8fb379fae29dab9046c971dcced543f']],
    ['references/troubleshooting.md', ['78ad122c14f1c5081ef698c880c4a250a99eb7a6ccbb1b39674359e712261fc6']],
    ['references/uninstall.md', ['10a97318e8bc6a94a0413e6d1b1b516b24ab8fd7f52d118cfc0d92c97394b892']],
  ])],
  ['teamai-share-learnings', new Map([
    ['SKILL.md', ['2bfdfa9c4f312424e06544fe104fbf5988cf5a6b3f2289215cbe89fb430d18c0', '676da346cf38c3d40d681a28bd2330abf825ec534ed774996362b3a91d20981a', '7771ec3997b747e4e270818189a1f450cc7e7307cc14c15b42491a2f20e94494', 'a47169735ee710bb38c21fa72e8f647ca2078b1cfd538bad78e30a0806f179c5', 'e7ab73f2258e13b55c91bffdd07975b13fb7a34c84c81215340a8239432f358b', 'f2d7c437520d8707182fbd3b4ca0dd453315d5210d924abb7dfa25aee651a94f']],
  ])],
  ['team-wiki-codebase', new Map([
    ['README.md', ['4e1ab336bfa6d78085572b4e0fc0e345bda0ec2be065279f189a8f2939f242b8', '82945615d4706b2c1b581d2b326c15536be0b8573472c359d1414690f0b2e804', 'd3c7312663caa8cefccd1034127fe7091384b8e603fcd04961f4f30a8ff1fe0e']],
    ['SKILL.md', ['47ebc8f3ac3f39551e96ef46ede14e3e076fe68acee3b431c5598b09df433904', '4d7e728e0c821404d760a63f994e6d0fe81519bd875e2d4297d178bffd292266', '4e6f1b937270e90cf53351e117cf8a4de19cbcca37b90603abe9532a9fe3a4c0', 'f6ebd80e036cc37dd049597c20bea5c28f267729d8c6af636ee5c61f60092af5', 'fad8ee99235ca195438dd4e52853d42c8f53b09bed4febd0f330039dee804907']],
    ['references/agents/graph-rag-agent.md', ['d79e52cfec1e131877f7fa28bb14993b937fb643ed6778fde6bf569dbd0ba2d3']],
    ['references/agents/kb-doc-generator.md', ['8dc1f1ef5e5d270223586567629b66333a07c42ae103ac5cdef6c755364587d5']],
    ['references/methodology/phase0-collection.md', ['1061ff28e17aa290dc0942958bac0ea0844b3b830fabda3dd9e03ac32c02b0b0', '89caa5e6e5135b19e39ebf48224a31ae6ea80bbef84c7c2e4cf50b6391220cf6']],
    ['references/methodology/phase1-reverse-engineering.md', ['9d709e09a30ca198020fe7f2470980a4d2f4889a685dc33f71c79f6433110a59']],
    ['references/methodology/phase2-document-types.md', ['62eee3e3290cbc1a4a7c40bcac5e7d8f2100989b438726b867af448dfda67b7b']],
    ['references/methodology/phase3-ai-enhancement.md', ['efe1536f1ea4a2ffeb9ab69409ce1cb172fe8a5b8efb583a46ed69ed976bc6d0']],
    ['references/methodology/phase4-quality.md', ['a7b536ab120a8c4bc3fbd53256675309a399e53b4d0d202abd5df1b82c985754']],
    ['references/templates/project-overview.md', ['296c15c827ae7798bf9f3112b84d1bdd69b0807bb80286cfc78f1a0d956e66ec']],
    ['scripts/scan_repo.py', ['a941f3ac9a260c860cfeded26eb6c6f3d55cc5af748e1e5f673a94278c6a9c36']],
    ['scripts/validate_kb.py', ['c6e08b03b80a60048374637b4de20afdd21b552892e915b8301efb368316522f']],
  ])],
]);
