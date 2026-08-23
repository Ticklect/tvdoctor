import { describe, expect, it } from "vitest";

import {
  createCanonicalSemanticIdentity,
  createSemanticIssueId,
  type SemanticIdentityField,
  type SemanticIdentityValue,
} from "../src/index.js";

describe("stable semantic issue identity", () => {
  const fields = (): readonly SemanticIdentityField[] => [
    ["version", 1],
    ["rule", "remote.reachability"],
    ["parts", ["home", "watch", "more-info"]],
  ];

  it("has an explicit canonical JSON and legacy hash contract", () => {
    const canonical = createCanonicalSemanticIdentity(fields());

    expect(canonical).toBe(
      "{\"version\":1,\"rule\":\"remote.reachability\",\"parts\":[\"home\",\"watch\",\"more-info\"]}",
    );
    expect(createSemanticIssueId("NAV", canonical)).toBe(
      "TVDOCTOR-NAV-0CE1C17FC80298A3303E7CF51A8E7D6F",
    );
  });

  it("is deterministic across fresh equivalent values", () => {
    const first = createCanonicalSemanticIdentity(fields());
    const second = createCanonicalSemanticIdentity(fields());

    expect(second).toBe(first);
    expect(createSemanticIssueId("NAV", second)).toBe(createSemanticIssueId("NAV", first));
  });

  it("separates domains even when the semantic identity is identical", () => {
    const canonical = createCanonicalSemanticIdentity(fields());
    const navigation = createSemanticIssueId("NAV", canonical);
    const streaming = createSemanticIssueId("STREAM", canonical);

    expect(navigation).not.toBe(streaming);
    expect(navigation.slice("TVDOCTOR-NAV-".length)).toBe(
      streaming.slice("TVDOCTOR-STREAM-".length),
    );
  });

  it("treats declared field order and array order as part of the identity", () => {
    const original = createCanonicalSemanticIdentity(fields());
    const reorderedFields = createCanonicalSemanticIdentity([
      ["rule", "remote.reachability"],
      ["version", 1],
      ["parts", ["home", "watch", "more-info"]],
    ]);
    const reorderedParts = createCanonicalSemanticIdentity([
      ["version", 1],
      ["rule", "remote.reachability"],
      ["parts", ["watch", "home", "more-info"]],
    ]);

    expect(reorderedFields).not.toBe(original);
    expect(reorderedParts).not.toBe(original);
    expect(createSemanticIssueId("NAV", reorderedFields)).not.toBe(
      createSemanticIssueId("NAV", original),
    );
    expect(createSemanticIssueId("NAV", reorderedParts)).not.toBe(
      createSemanticIssueId("NAV", original),
    );
  });

  it("rejects ambiguous or lossy identity data instead of silently coercing it", () => {
    expect(() => createCanonicalSemanticIdentity([["", 1]])).toThrow(/must not be empty/u);
    expect(() => createCanonicalSemanticIdentity([["rule", "a"], ["rule", "b"]])).toThrow(/duplicated/u);
    expect(() => createCanonicalSemanticIdentity([["number", Number.NaN]])).toThrow(/finite/u);
    expect(() => createCanonicalSemanticIdentity([["number", Number.POSITIVE_INFINITY]])).toThrow(/finite/u);

    const sparse: SemanticIdentityValue[] = [];
    sparse.length = 1;
    expect(() => createCanonicalSemanticIdentity([["items", sparse]])).toThrow(/sparse/u);

    const cyclic: { self?: SemanticIdentityValue } = {};
    cyclic.self = cyclic as SemanticIdentityValue;
    expect(() => createCanonicalSemanticIdentity([
      ["cycle", cyclic as SemanticIdentityValue],
    ])).toThrow(/cyclic/u);
  });

  it("requires an uppercase domain and the builder's canonical-string form", () => {
    const canonical = createCanonicalSemanticIdentity(fields());

    for (const domain of ["", "nav", "NAV_2", "-NAV", "NAV-", "NAV--WEB"]) {
      expect(() => createSemanticIssueId(domain, canonical)).toThrow(/domain/u);
    }
    expect(() => createSemanticIssueId("NAV", "not-json")).toThrow(/canonical JSON/u);
    expect(() => createSemanticIssueId("NAV", '{ "version": 1 }')).toThrow(/canonical JSON/u);
    expect(() => createSemanticIssueId("NAV", "[]")).toThrow(/JSON object/u);
  });
});
