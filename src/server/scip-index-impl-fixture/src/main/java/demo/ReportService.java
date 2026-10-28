package demo;

public class ReportService implements ReportPort {
    @Override
    public String render(Report report) {
        return report.summary();
    }
}
