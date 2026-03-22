use std::process::Command;

pub trait CommandBackgroundExt {
    fn for_background_job(&mut self) -> &mut Self;
}

impl CommandBackgroundExt for Command {
    fn for_background_job(&mut self) -> &mut Self {
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;

            const CREATE_NO_WINDOW: u32 = 0x08000000;
            self.creation_flags(CREATE_NO_WINDOW);
        }

        self
    }
}
