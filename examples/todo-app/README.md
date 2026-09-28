# Todo app checkpoint

This is the working todo app built and maintained by the real QM swarm agents.
The checkpoint uses JSON storage and includes the stale-migration regression fix.
List reordering has not been added yet, so it can be dispatched during the demo.

Run this copy independently with Node 24:

```bash
cd examples/todo-app
npm run reset
npm start
```

Open <http://localhost:3000>. There are no package dependencies to install.
`npm test` verifies storage persistence and the migration regression.
`npm run reset` replaces this copy's local todo data with the three recorded demo
items. The running Docker demo uses its own shared workspace volume.

To return the entire Docker demo to the saved agent, memory, app, and data state,
use the checkpoint commands in [the local demo instructions](../../deploy/local/README.md).
The runtime checkpoint remains local and ignored by Git. This directory preserves
both the app source and nonsensitive demo seed data in the pushed repository.
