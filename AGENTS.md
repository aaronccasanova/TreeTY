# Package versioning

Include the appropriate semantic version bump whenever a change affects a package's shipped behavior. For Pi extension changes, bump only `packages/pi/package.json`. The private workspace root is not a versioned deliverable and its `package.json` must not have a `version`. Update any documentation or changelog that states the affected package version. Follow `RELEASING.md` for the complete release workflow.
