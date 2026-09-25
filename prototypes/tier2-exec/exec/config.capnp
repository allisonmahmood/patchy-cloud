# PROTOTYPE for #311: one workerd process per execution task. The "loader"
# Worker holds a workerLoader binding and loads one dynamic Worker per
# (company, patch, version) from the bundle the host sends.
using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    ( name = "loader",
      worker = (
        modules = [ (name = "loader.js", esModule = embed "loader.js") ],
        compatibilityDate = "2025-09-01",
        compatibilityFlags = ["nodejs_compat", "enable_ctx_exports", "experimental"],
        bindings = [ (name = "loader", workerLoader = ()) ],
        # The loader Worker itself may reach the host's private VPC address.
        globalOutbound = "vpc",
      )
    ),
    ( name = "vpc", network = ( allow = ["private", "public"] ) ),
  ],
  sockets = [ ( name = "http", address = "127.0.0.1:8787", http = (), service = "loader" ) ],
);
