import { describe, expect, it } from "vitest";
import {
  CANONICAL_IMAGE_NAME,
  isReleasedVersionRef,
  selectDeploymentTarget,
} from "../src/server/deployment-image.js";

describe("server deployment image — canonical registry identity", () => {
  it("uses the one published GHCR image name", () => {
    expect(CANONICAL_IMAGE_NAME).toBe("ghcr.io/code-ministry-ltd/the-librarian");
  });
});

describe("server deployment image — strict released-version recognition", () => {
  it.each([
    ["v0.0.0", true],
    ["v1.20.1", true],
    ["v10.200.3000", true],
    ["1.20.1", false],
    ["v1.20", false],
    ["v1.20.1-beta.1", false],
    ["v1.20.1+build", false],
    ["v01.20.1", false],
    ["v1.020.1", false],
    ["v1.20.01", false],
    [" v1.20.1", false],
    ["v1.20.1 ", false],
  ])("classifies %j as released=%s", (ref, released) => {
    expect(isReleasedVersionRef(ref)).toBe(released);
  });
});

describe("server deployment image — target selection", () => {
  it.each([
    [undefined, { imageSource: "registry" }],
    ["", { imageSource: "registry" }],
    ["   ", { imageSource: "registry" }],
    ["v1.20.1", { imageSource: "registry", ref: "v1.20.1" }],
    ["main", { imageSource: "source", ref: "main" }],
    ["feature/pull-images", { imageSource: "source", ref: "feature/pull-images" }],
    ["release-candidate", { imageSource: "source", ref: "release-candidate" }],
    ["8f1f0f3", { imageSource: "source", ref: "8f1f0f3" }],
    ["v1.20", { imageSource: "source", ref: "v1.20" }],
    ["v1.20.1-beta.1", { imageSource: "source", ref: "v1.20.1-beta.1" }],
    [" v1.20.1 ", { imageSource: "source", ref: " v1.20.1 " }],
    [" main ", { imageSource: "source", ref: " main " }],
  ])("selects %j as %j", (ref, target) => {
    expect(selectDeploymentTarget(ref)).toEqual(target);
  });
});
