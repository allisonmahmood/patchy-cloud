# Company database

The home of a company's patch-owned resources, separate from the platform records that identify companies, users and patches.

## Language

**Company database**:
The database holding one company's patch resources and their inventory. It belongs to the company, not to an individual patch.
_Avoid_: tenant database, patch database

**Placement**:
The authoritative record of where a company's database lives and whether it is claimed or ready. Its version identifies a particular placement, not a patch version.
_Avoid_: connection, allocation

**Namespace**:
A patch's physical home inside its company database. It groups the patch's resources without changing their ownership.
_Avoid_: database, company schema

**Inventory**:
The cumulative record of resources provisioned for a patch, including its schema revision and table sharing. A published version describes what it uses; the inventory describes what still exists.
_Avoid_: active manifest, catalog snapshot

**Patch lock**:
The exclusive right to change a patch's resource definitions. It complements the platform patch-row lock rather than replacing it; ordinary file-content operations do not take it.
_Avoid_: publish lock, company lock

**File lock**:
The exclusive right to change the file-index entry for one patch, store and name. It does not exclude operations on unrelated file names or cover the transfer of file contents.
_Avoid_: patch lock, company lock

**Provisioning login**:
The operator credential allowed to create company databases and establish their ownership and permissions. It is distinct from the data login used for ordinary company operations.
_Avoid_: data role, company credential
