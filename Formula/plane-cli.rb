class PlaneCli < Formula
  desc "CLI for Silicon Alchemists' customized Plane deployment"
  homepage "https://github.com/RenderCoder/plane-cli"
  version "0.1.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RenderCoder/plane-cli/releases/download/plane-cli-v0.1.0/plane-cli-darwin-arm64.tar.gz"
      sha256 "4be579ae57cfc8539156f6eb2b176c7ceb9b4b1349b0cf2ab202ecc718f6d0a7"
    end
    on_intel do
      url "https://github.com/RenderCoder/plane-cli/releases/download/plane-cli-v0.1.0/plane-cli-darwin-x64.tar.gz"
      sha256 "d9b8de73118091706ca7e0c3157d307fcbf76ebe2e7ef2e15150e368397f57e8"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/RenderCoder/plane-cli/releases/download/plane-cli-v0.1.0/plane-cli-linux-x64.tar.gz"
      sha256 "ca1683be0a862587fdea26a77a9518ede46d71e0549c0982f260b7e4f707c856"
    end
  end

  def install
    bin.install "plane-cli"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/plane-cli --version")
  end
end
