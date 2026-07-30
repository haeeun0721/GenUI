/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    rules: {
      "react/prop-types": "off",
      "react/no-unknown-property": [
        "error",
        {
          ignore: [
            "jsx",
            // React Three Fiber properties
            "args",
            "position",
            "rotation",
            "intensity",
            "distance",
            "metalness",
            "roughness",
            "emissive",
            "emissiveIntensity",
            "wireframe",
            "transparent",
          ],
        },
      ],
    },
  },
];
