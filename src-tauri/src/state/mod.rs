//! Pure state logic: the session state machine, the texts it derives from
//! Claude's messages and tools, and the derivation of a task's ring and second line.

pub mod derive;
pub mod machine;
pub mod summary;
