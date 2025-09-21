import Lake
open Lake DSL

package «svi-surface»

lean_lib SviSurface

lean_exe «svi-surface-test» {
  root := `SviSurface.Tests
}
