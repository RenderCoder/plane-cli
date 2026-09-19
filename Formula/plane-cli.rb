class PlaneCli < Formula
  desc "CLI for Silicon Alchemists' customized Plane deployment"
  homepage "https://github.com/RenderCoder/plane-cli"
  version "0.1.3"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/RenderCoder/plane-cli/releases/download/plane-cli-v0.1.3/plane-cli-darwin-arm64.tar.gz"
      sha256 "4635f2368104c2d5f000d4baebb8c50649885e1af2693976e539901eaf1d5ab1"
    end
    on_intel do
      url "https://github.com/RenderCoder/plane-cli/releases/download/plane-cli-v0.1.3/plane-cli-darwin-x64.tar.gz"
      sha256 "8c190750ea376b5da537b45cfad770e23741549d61c28e4144c84195fb5ee605"
    end
  end

  on_linux do
    on_intel do
      url "https://github.com/RenderCoder/plane-cli/releases/download/plane-cli-v0.1.3/plane-cli-linux-x64.tar.gz"
      sha256 "c8c6bc08ce829efb34ed3a61d3ca4f6f05e20a94fd4dde250c6d77e4e596527d"
    end
  end

  def install
    bin.install "plane-cli"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/plane-cli --version")
  end
end

